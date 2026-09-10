import { Decimal } from "decimal.js";

const NUMBER = /^\d+(?:[.,]\d{1,2})?[кk]?$/iu;
const ERROR =
  "Введите сумму 15000 или диапазон 10000–15000. Пробелы и «15к» допустимы; валюта уже выбрана.";

function amount(text: string): number {
  if (!NUMBER.test(text)) throw new Error(ERROR);
  const thousands = /[кk]$/iu.test(text);
  const value = new Decimal((thousands ? text.slice(0, -1) : text).replace(",", ".")).mul(
    thousands ? 100000 : 100,
  );
  if (value.gt(10 ** 13)) throw new Error("Сумма слишком большая. Проверьте количество цифр.");
  return value.toNumber();
}

export function parseBudget(text: string): [number, number] {
  if (text.length > 80) throw new Error(ERROR);
  const parts = text.replace(/\s/gu, "").replace(/[–—]/gu, "-").split("-");
  let minimum: number;
  let maximum: number;
  if (parts.length === 1) {
    minimum = 0;
    maximum = amount(parts[0]!);
  } else if (parts.length === 2) {
    minimum = amount(parts[0]!);
    maximum = amount(parts[1]!);
  } else throw new Error(ERROR);
  if (maximum <= 0 || minimum > maximum) {
    throw new Error("Верхняя граница должна быть больше нуля и не меньше нижней.");
  }
  return [minimum, maximum];
}

export function money(minor: number, currency: string): string {
  if (!["USD", "KGS", "KRW"].includes(currency)) throw new Error("Unsupported currency");
  if (!Number.isSafeInteger(minor)) throw new Error("Money must be a safe integer");
  const divisor = currency === "KRW" ? 1n : 100n;
  const integer = BigInt(minor);
  let whole = integer / divisor;
  let fractional = integer % divisor;
  if (fractional < 0n) {
    whole -= 1n;
    fractional += divisor;
  }
  let rendered = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/gu, " ");
  if (fractional !== 0n) rendered += `,${fractional.toString().padStart(2, "0")}`;
  const suffix = currency === "USD" ? "$" : currency === "KGS" ? "сом" : "KRW";
  return `${rendered} ${suffix}`;
}
