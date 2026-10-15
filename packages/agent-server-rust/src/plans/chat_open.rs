use super::Plan;
use crate::ia::actions;
use crate::ia::selectors::{query_selector, query_selector_all};
use crate::ia::types::*;
use crate::tools::chat_select::{open_chat, OpenChatResult};

pub struct ChatOpenPlan;

pub struct ChatOpenParams {
    pub chat_id: String,
    pub clear_unreads: bool,
}

pub struct ChatOpenPlanState {
    pub phase: ChatOpenPhase,
    pub result: Option<OpenChatResult>,
}

pub enum ChatOpenPhase {
    Opening,
    Focusing,
    ClickingAudio,
    Done,
}

fn find_edit_area(a11y: &A11yNode) -> Option<&A11yNode> {
    let mut edits: Vec<&A11yNode> = Vec::new();
    let mut sends: Vec<&A11yNode> = Vec::new();
    collect_edit_and_send_nodes(a11y, &mut edits, &mut sends);

    let send_btn = sends
        .into_iter()
        .filter(|n| n.bounds.as_ref().map(|b| b.y).unwrap_or(0.0) >= 650.0)
        .max_by(|a, b| {
            let ay = a.bounds.as_ref().map(|bb| bb.y).unwrap_or(0.0);
            let by = b.bounds.as_ref().map(|bb| bb.y).unwrap_or(0.0);
            ay.partial_cmp(&by).unwrap_or(std::cmp::Ordering::Equal)
        })?;

    let send_bounds = send_btn.bounds.as_ref()?;

    edits
        .into_iter()
        .filter(|n| n.bounds.is_some())
        .filter(|n| {
            let b = n.bounds.as_ref().unwrap();
            b.y >= 620.0 && b.y <= send_bounds.y && b.x <= send_bounds.x
        })
        .min_by(|a, b| {
            let ab = a.bounds.as_ref().unwrap();
            let bb = b.bounds.as_ref().unwrap();
            let ad = (send_bounds.y - ab.y).abs() + (send_bounds.x - ab.x).abs();
            let bd = (send_bounds.y - bb.y).abs() + (send_bounds.x - bb.x).abs();
            ad.partial_cmp(&bd).unwrap_or(std::cmp::Ordering::Equal)
        })
}

fn collect_edit_and_send_nodes<'a>(node: &'a A11yNode, edits: &mut Vec<&'a A11yNode>, sends: &mut Vec<&'a A11yNode>) {
    let is_editable = node.role == "text"
        && node
            .states
            .as_ref()
            .map(|s| s.iter().any(|st| st == "EDITABLE"))
            .unwrap_or(false);
    if is_editable {
        edits.push(node);
    }

    if node.role == "push-button" && node.name == "Send(S)" {
        sends.push(node);
    }

    if let Some(children) = &node.children {
        for child in children {
            collect_edit_and_send_nodes(child, edits, sends);
        }
    }
}

#[async_trait::async_trait]
impl Plan for ChatOpenPlan {
    type PlanState = ChatOpenPlanState;
    type Params = ChatOpenParams;

    fn id(&self) -> &str { "chat_open" }

    fn initial_plan_state(&self) -> ChatOpenPlanState {
        ChatOpenPlanState {
            phase: ChatOpenPhase::Opening,
            result: None,
        }
    }

    fn is_goal_reached(&self, _state: &AppState, plan_state: &ChatOpenPlanState) -> bool {
        matches!(plan_state.phase, ChatOpenPhase::Done)
    }

    async fn select_action(
        &self,
        state: &AppState,
        params: &ChatOpenParams,
        identified: &IdentifiedStates,
        plan_state: &mut ChatOpenPlanState,
        a11y: &A11yNode,
        _session_id: &str,
    ) -> Option<SelectedAction> {
        // Dismiss popups
        if state.popup.is_some() && identified.popup.is_some() {
            return Some(SelectedAction {
                action: actions::dismiss_popup(),
                frame: identified.main_window.as_ref().and_then(|m| m.frame.clone()),
            });
        }

        let main_state_id = identified.main_window.as_ref().map(|m| m.state_id.as_str());

        loop {
            match &plan_state.phase {
                ChatOpenPhase::Opening => {
                    if main_state_id != Some("chat") && main_state_id != Some("chat_open") {
                        return None;
                    }

                    // Find click target
                    let chat_list_item = query_selector(a11y, r#"list[name="Chats"] > list-item"#);
                    let click_xy = chat_list_item.and_then(|item| {
                        item.bounds.as_ref().map(|b| {
                            (
                                (b.x + b.width / 2.0).round(),
                                (b.y + b.height / 2.0).round(),
                            )
                        })
                    });

                    let force = main_state_id == Some("chat");
                    let result = open_chat(&params.chat_id, force, click_xy).await;

                    if !result.ok {
                        plan_state.result = Some(result);
                        return None;
                    }

                    let skipped = result.skipped.unwrap_or(false);
                    plan_state.result = Some(result);

                    if params.clear_unreads {
                        plan_state.phase = ChatOpenPhase::Focusing;
                        tracing::info!("[chat_open] Opening → Focusing, skipped={}", skipped);
                        if !skipped {
                            return Some(SelectedAction {
                                action: actions::wait_short(),
                                frame: identified.main_window.as_ref().and_then(|m| m.frame.clone()),
                            });
                        }
                        continue;
                    }

                    // No clear_unreads — still require that the chat pane is actually open.
                    if main_state_id != Some("chat_open") {
                        tracing::info!("[chat_open] Opening: still in state {:?} -> wait/retry", main_state_id);
                        return Some(SelectedAction {
                            action: actions::wait_short(),
                            frame: identified.main_window.as_ref().and_then(|m| m.frame.clone()),
                        });
                    }

                    if find_edit_area(a11y).is_none() {
                        tracing::info!("[chat_open] Opening: chat_open without edit area -> wait/retry");
                        return Some(SelectedAction {
                            action: actions::wait_short(),
                            frame: identified.main_window.as_ref().and_then(|m| m.frame.clone()),
                        });
                    }

                    plan_state.phase = ChatOpenPhase::Done;
                    tracing::info!("[chat_open] Opening → Done (no clear_unreads, edit area found)");
                    return Some(SelectedAction {
                        action: actions::wait_short(),
                        frame: identified.main_window.as_ref().and_then(|m| m.frame.clone()),
                    });
                }

                ChatOpenPhase::Focusing => {
                    if main_state_id != Some("chat_open") {
                        tracing::info!("[chat_open] Focusing: wrong state {:?}", main_state_id);
                        return None;
                    }

                    let edit_node = match find_edit_area(a11y) {
                        Some(n) => n,
                        None => {
                            tracing::info!("[chat_open] Focusing: edit area not found");
                            return None;
                        }
                    };

                    plan_state.phase = ChatOpenPhase::ClickingAudio;
                    tracing::info!("[chat_open] Focusing → ClickingAudio, edit_bounds={:?}", edit_node.bounds);

                    if let Some(bounds) = &edit_node.bounds {
                        return Some(SelectedAction {
                            action: actions::click_bounds(bounds),
                            frame: identified.main_window.as_ref().and_then(|m| m.frame.clone()),
                        });
                    }
                    continue;
                }

                ChatOpenPhase::ClickingAudio => {
                    if main_state_id != Some("chat_open") {
                        tracing::info!("[chat_open] ClickingAudio: wrong state {:?}", main_state_id);
                        return None;
                    }

                    let unplayed = query_selector_all(
                        a11y,
                        r#"list[name="Messages"] > list-item[name=/^Audio.*Unplay/s]"#,
                    );

                    // Build a sequence: click each unplayed audio with a wait between
                    let mut seq: Vec<Action> = Vec::new();
                    for node in &unplayed {
                        if let Some(bounds) = &node.bounds {
                            let x = (bounds.x + 100.0).round();
                            let y = (bounds.y + bounds.height / 2.0).round();
                            seq.push(actions::click_at(x, y));
                            seq.push(Action::Wait { ms: 500 });
                        }
                    }
                    tracing::info!("[chat_open] ClickingAudio: found {} unplayed, sequence of {} actions", unplayed.len(), seq.len());

                    plan_state.phase = ChatOpenPhase::Done;

                    if seq.is_empty() {
                        return Some(SelectedAction {
                            action: actions::wait_short(),
                            frame: identified.main_window.as_ref().and_then(|m| m.frame.clone()),
                        });
                    }

                    return Some(SelectedAction {
                        action: Action::Sequence { actions: seq },
                        frame: identified.main_window.as_ref().and_then(|m| m.frame.clone()),
                    });
                }

                ChatOpenPhase::Done => return None,
            }
        }
    }
}
