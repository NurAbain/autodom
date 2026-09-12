import { open } from "node:fs/promises";
import { loadBotSettings } from "@autodom/core";
import { Store } from "@autodom/storage";
import { PaymentStore } from "@autodom/storage/payments";
import { z } from "zod";
import { parseFlatJson } from "./http-body.js";
import { requirePaymentOrderId } from "./payments.js";

const HELP = `Autodom Finik order operations (trusted server operator only)

Usage: pnpm bot payments COMMAND
  offer FILE.json                    Create a buyer-specific physical inspection offer
  list TELEGRAM_USER_ID              List that buyer's orders
  show ORDER_ID                      Inspect one order and its confirmed payment status
  complete ORDER_ID                  Confirm an actually completed paid inspection
  cancel ORDER_ID                    Cancel an offer before invoice acceptance
  refund-request FILE.json           Record a full/partial refund REQUEST, not a refund
  refunds [ORDER_ID]                 List refund requests

Offer JSON requires userId, product="inspection", amount (KGS minor units, multiple100),
title, description (<=300), seller, supportUrl, terms, executor, expiresAt (ISO).
No default tariff, seller or executor; do not create an offer without a real service.
Offer creation sends no invoice, message, partner contact or payment operation.
Refund JSON: {"orderId":"UUID","amount":49900,"reason":"customer request"}.
Finik acquiring refund execution is NOT configured: requests never mean money returned.
This CLI requires only AUTODOM_DATABASE_URL, not a Telegram or Finik merchant key.
`;

const offerSchema = z
  .object({
    userId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    product: z.literal("inspection"),
    amount: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).multipleOf(100),
    title: z.string().min(1).max(300),
    description: z.string().min(1).max(300),
    seller: z.string().min(1).max(300),
    supportUrl: z.string().min(1).max(2048),
    terms: z.string().min(1).max(10000),
    executor: z.string().min(1).max(300),
    expiresAt: z.string().min(1).max(60),
  })
  .strict();
const refundSchema = z
  .object({
    orderId: z.string(),
    amount: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    reason: z.string().trim().min(1).max(2000),
  })
  .strict();

async function readInput(path: string): Promise<unknown> {
  const file = await open(path, "r");
  try {
    if (!(await file.stat()).isFile()) throw new Error("Input must be a regular JSON file");
    const bytes = Buffer.alloc(16_385);
    let size = 0;
    while (size < bytes.length) {
      const { bytesRead } = await file.read(bytes, size, bytes.length - size, null);
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size > 16_384) throw new Error("Input JSON exceeds 16 KiB");
    return parseFlatJson(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, size)));
  } finally {
    await file.close();
  }
}

export async function runPaymentsCommand(argv: string[], env: NodeJS.ProcessEnv): Promise<number> {
  process.umask(0o077);
  if (!argv.length || argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(HELP);
    return 0;
  }
  const [command, argument, ...extra] = argv;
  if (
    extra.length ||
    !["offer", "list", "show", "complete", "cancel", "refund-request", "refunds"].includes(
      command!,
    ) ||
    (command !== "refunds" && !argument)
  ) {
    process.stderr.write(HELP);
    return 2;
  }
  let store: Store | undefined;
  try {
    const input =
      command === "offer" || command === "refund-request" ? await readInput(argument!) : null;
    const offer = command === "offer" ? offerSchema.parse(input) : undefined;
    const refund = command === "refund-request" ? refundSchema.parse(input) : undefined;
    const userId = command === "list" ? Number(argument) : undefined;
    if (userId !== undefined && (!/^[1-9]\d*$/u.test(argument!) || !Number.isSafeInteger(userId)))
      throw new Error("Invalid Telegram user ID");
    if (["show", "complete", "cancel", "refunds"].includes(command!) && argument)
      requirePaymentOrderId(argument);
    if (refund) requirePaymentOrderId(refund.orderId);
    store = await Store.open(loadBotSettings(env).database_url);
    const payments = new PaymentStore(store);
    let result: unknown;
    if (offer) result = await payments.createOffer(offer);
    else if (refund) {
      result = {
        request: await payments.requestRefund(refund.orderId, refund.amount, refund.reason),
        moneyReturned: false,
        note: "Только заявка на возврат. Исполнение и подтверждение Finik не подключены.",
      };
    } else if (command === "list") result = await payments.listOrders(userId!);
    else if (command === "refunds") result = await payments.listRefunds(argument);
    else {
      const order = await payments.getOrder(argument!);
      if (!order) throw new Error("Order not found");
      if (command === "show") result = order;
      else if (command === "complete") {
        if (!(await payments.completeInspection(order.id)))
          throw new Error("Inspection cannot be marked complete");
        result = await payments.getOrder(order.id);
      } else {
        if (!(await payments.cancelOffer(order.id, order.userId)))
          throw new Error("An outstanding or paid invoice cannot be cancelled locally");
        result = await payments.getOrder(order.id);
      }
    }
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  } catch (error) {
    if (error instanceof z.ZodError)
      process.stderr.write(
        `Invalid order input: ${error.issues.map((issue) => issue.path.join(".")).join(", ")}\n`,
      );
    else
      process.stderr.write(
        "Order operation was not confirmed. Check the input, database and current order state; no refund is implied.\n",
      );
    return 1;
  } finally {
    await store?.close();
  }
}
