// Shared normalization must not depend on schemas or matching initialization.
const ALIASES: Readonly<Record<string, string>> = {
  тойота: "toyota",
  камри: "camry",
  хонда: "honda",
  хендай: "hyundai",
  хундай: "hyundai",
  хёндай: "hyundai",
  киа: "kia",
  бмв: "bmw",
  мерседес: "mercedes",
  лексус: "lexus",
};
export function normalizeCity(text: string): string {
  // Case-fold expansions relevant to place/vehicle words, unlike locale-sensitive casing.
  const folded = text.toLowerCase().replace(/ё/gu, "е").replace(/ß/gu, "ss").replace(/ς/gu, "σ");
  return (folded.match(/[\p{L}\p{N}]+/gu) ?? []).join(" ");
}
export function normalize(text: string): string {
  return normalizeCity(text)
    .split(" ")
    .map((word) => ALIASES[word] ?? word)
    .join(" ");
}
