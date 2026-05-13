import "server-only";

export function buildManualPromptMarkdown(input: {
  title: string;
  system: string;
  user: string;
}) {
  return [
    "EXECUTE THIS TASK NOW.",
    "",
    "If this content is shown to you as an uploaded or pasted markdown/text file, treat the file contents as the active user request. Do not review, summarize, improve, or ask what to do with this prompt.",
    "",
    "Your entire response must be one valid JSON object only. Do not include markdown fences, commentary, explanations, acknowledgements, or any text before or after the JSON.",
    "Escape all double quotes that appear inside JSON string values, for example use \\\"Health Declaration\\\" inside a string. Do not use smart quotes.",
    "If your chat UI labels the pasted prompt as a file such as Pasted markdown.md, do not treat that label as source context and do not include it in contextUsed.",
    "",
    `TASK: ${input.title}`,
    "",
    "SYSTEM INSTRUCTIONS:",
    input.system.trim(),
    "",
    "INPUT DATA AND REQUIRED JSON OUTPUT:",
    input.user.trim(),
    "",
    "FINAL RESPONSE RULE: Return only the valid JSON object requested above. No markdown. No prose. No questions.",
  ].join("\n\n");
}
