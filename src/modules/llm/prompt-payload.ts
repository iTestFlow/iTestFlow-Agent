import "server-only";

export function buildTaggedPromptPayload(sections: Array<{ tag: string; value: unknown }>) {
  return sections
    .map((section) => `<${section.tag}>\n${formatSectionValue(section.value)}\n</${section.tag}>`)
    .join("\n\n");
}

function formatSectionValue(value: unknown) {
  if (typeof value === "string") return value;
  return JSON.stringify(value, null, 2);
}
