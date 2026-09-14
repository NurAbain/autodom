const htmlEntities = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#x27;" };

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => htmlEntities[char as keyof typeof htmlEntities]);
}
