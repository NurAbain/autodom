import type { OwnerVehicle } from "@autodom/core/owner-vehicle";
import { describe, expect, it } from "vitest";
import type { Reply } from "../src/conversation.js";
import { SellerConversation } from "../src/seller-conversation.js";

describe("seller vehicle flow", () => {
  for (const purpose of ["sale", "property"] as const) {
    it(`keeps characteristics and asks for photos after price for ${purpose}`, async () => {
      let saved: OwnerVehicle | null = null;
      const flow = new SellerConversation({
        getOwnerVehicle: async () => saved,
        saveOwnerVehicle: async (card) => (saved = card),
        deleteOwnerVehicle: async () => {},
        estimateOwnerPrice: async () => ({
          currency: "USD",
          medianMinor: 1_500_000,
          lowMinor: 1_400_000,
          highMinor: 1_600_000,
          sampleSize: 6,
          observedAt: 1_780_000_000,
        }),
      });
      let replies = (await flow.handle(1, 1, "/sell"))!;
      const choose = async (value: string): Promise<Reply[]> => {
        const action = replies[0]!.buttons
          .flat()
          .find(([, callback]) => callback.endsWith(`:${value}`));
        expect(action).toBeDefined();
        return (await flow.handle(1, 1, action![1]))!;
      };
      replies = await choose("consent");
      replies = await choose(purpose);
      expect(replies[0]!.input?.vehicle).toBe(true);
      replies = (await flow.handle(1, 1, "Toyota Camry, 2018, 120000, sedan, automatic"))!;
      expect(replies[0]!.input?.label).toBe("Желаемая цена");
      replies = (await flow.handle(1, 1, "15000 USD"))!;
      expect(replies[0]!.ownerPhotos).toBe("select");
      replies = await choose("continue");
      if (purpose === "property") {
        expect(replies[0]!.input).toBeUndefined();
        replies = await choose("city-done");
        expect(replies[0]!.text).toContain("Выберите хотя бы один город");
        replies = await choose("city.0");
        replies = await choose("city.1");
        expect(replies[0]!.buttons.flat().map(([label]) => label)).toContain("✓ Ош");
        replies = await choose("city-done");
        replies = await choose("apartment");
        replies = await choose("skip");
        replies = await choose("skip");
      }
      replies = await choose("save");
      expect(saved).toMatchObject({
        make_model: "Toyota Camry",
        year: 2018,
        mileage_km: 120000,
        body_type: "sedan",
        transmission: "automatic",
      });
      expect(replies[0]!.ownerPhotos).toBe("saved");
      if (purpose === "property") {
        expect(saved!.property_city).toBe("Бишкек, Ош");
        replies = await choose("edit.city");
        expect(replies[0]!.buttons.flat().map(([label]) => label)).toContain("✓ Бишкек");
        replies = await choose("city.0");
        replies = await choose("back");
        expect(replies[0]!.text).toContain("Бишкек, Ош");
        expect(saved!.property_city).toBe("Бишкек, Ош");
        saved!.property_city = "Сокулук";
        replies = (await flow.handle(1, 1, "/mycar"))!;
        replies = await choose("edit.city");
        expect(replies[0]!.buttons.flat().map(([label]) => label)).toContain("✓ Сокулук");
        replies = await choose("city.0");
        replies = await choose("city-done");
        replies = await choose("save");
        expect(saved!.property_city).toBe("Сокулук, Бишкек");
      }
      flow.clear(1);
    });
  }
});
