export const MAGPI_ACP_NAVIGATE_TREE_COMMAND =
  "__magpi_acp_internal_navigate_tree";

export const MAGPI_ACP_FORK_MESSAGE_ID_META = "magpi-acp/fork-message-id";
export const MAGPI_ACP_NAVIGATE_TREE_METHOD =
  "_magpi-acp/session/navigate-tree";

export interface TreeNavigationOptions {
  summarize: boolean;
  customInstructions?: string;
}

export const MAGPI_ACP_MESSAGE_TARGET_ACTIONS_CAPABILITY =
  "magpi-acp/message-target-actions";
export const MAGPI_ACP_BRANCH_SUMMARY_CAPABILITY = "magpi-acp/branch-summary";
