import { expect, it } from "vitest";
import { loadFinikGatewaySettings } from "../src/payments.js";

it("refuses real invoice creation configuration without a durable receipt listener", () => {
  expect(() =>
    loadFinikGatewaySettings({
      AUTODOM_PAYMENTS_GATEWAY_URL: "https://payments.example.test",
      AUTODOM_PAYMENTS_GATEWAY_TOKEN: "server-only-gateway-fixture",
    }),
  ).toThrow();
});
