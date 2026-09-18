const textFromBlock = (block: unknown): string => {
  const contentBlock = block as { type?: unknown; text?: unknown } | null;
  return contentBlock?.type === "text" && typeof contentBlock.text === "string"
    ? contentBlock.text
    : "";
};

export const normalizePiMessageText = (content: unknown): string => {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content.map(textFromBlock).filter(Boolean).join("");
};

export const normalizePiAssistantText = (content: unknown): string => {
  // Assistant content is typically an array of blocks; only replay text blocks for MVP.
  if (!Array.isArray(content)) {
    return "";
  }
  return content.map(textFromBlock).filter(Boolean).join("");
};
