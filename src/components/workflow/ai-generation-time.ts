export function formatElapsedTime(elapsedSeconds: number) {
  const seconds = Math.max(0, Math.floor(elapsedSeconds));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}
