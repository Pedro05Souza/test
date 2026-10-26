import { describe, expect, test } from "bun:test";
import { CurrencyMismatchError, InvalidMoneyError } from "../../src/shared/domain/errors";
import { Money } from "../../src/shared/domain/money";
import { brl, usd } from "./fixtures";

describe("Money", () => {
  describe("parsing", () => {
    test.each(["0", "0.00", "25", "25.5", "25.50", "1000.00", "999999999999999999.99"])(
      "accepts %p",
      (amount) => {
        expect(() => brl(amount)).not.toThrow();
      },
    );

    test.each([
      ["empty string", ""],
      ["NaN", "NaN"],
      ["Infinity", "Infinity"],
      ["scientific notation", "1e3"],
      ["negative", "-1.00"],
      ["explicit plus sign", "+1.00"],
      ["three decimals", "1.001"],
      ["trailing dot", "1."],
      ["leading dot", ".50"],
      ["leading zeros", "01.00"],
      ["whitespace", " 1.00"],
      ["comma separator", "1,00"],
      ["too many integer digits", "1000000000000000000.00"],
    ])("rejects %s", (_label, amount) => {
      expect(() => brl(amount)).toThrow(InvalidMoneyError);
    });

    test("rejects non-string amounts (numbers are never accepted for money)", () => {
      expect(() => Money.from({ amount: 25 as unknown as string, currency: "BRL" })).toThrow(InvalidMoneyError);
    });

    test.each(["brl", "BR", "BRLX", "", "R$"])("rejects currency %p", (currency) => {
      expect(() => Money.from({ amount: "1.00", currency })).toThrow(InvalidMoneyError);
    });
  });

  describe("serialization", () => {
    test("always serializes with scale 2", () => {
      expect(brl("25").toJSON()).toEqual({ amount: "25.00", currency: "BRL" });
      expect(brl("25.5").toJSON()).toEqual({ amount: "25.50", currency: "BRL" });
      expect(brl("0").toString()).toBe("0.00 BRL");
    });

    test("never yields negative zero", () => {
      expect(brl("0").negate().toJSON().amount).toBe("0.00");
      expect(brl("5.00").subtract(brl("5.00")).toJSON().amount).toBe("0.00");
    });

    test("round-trips without loss", () => {
      expect(Money.from(brl("123.45").toJSON()).equals(brl("123.45"))).toBe(true);
    });
  });

  describe("arithmetic", () => {
    test("is exact where floating point is not (0.1 + 0.2)", () => {
      expect(brl("0.10").add(brl("0.20")).toJSON().amount).toBe("0.30");
    });

    test("adds, subtracts and negates", () => {
      expect(brl("100.00").subtract(brl("80.00")).toJSON().amount).toBe("20.00");
      expect(brl("20.00").subtract(brl("80.00")).toJSON().amount).toBe("-60.00");
      expect(brl("12.34").negate().toJSON().amount).toBe("-12.34");
    });

    test("handles the largest supported amounts exactly", () => {
      const max = brl("999999999999999999.99");
      expect(max.subtract(brl("0.01")).toJSON().amount).toBe("999999999999999999.98");
      expect(max.add(brl("0.01")).toJSON().amount).toBe("1000000000000000000.00");
    });

    test("is immutable", () => {
      const a = brl("10.00");
      a.add(brl("5.00"));
      expect(a.toJSON().amount).toBe("10.00");
    });

    test("comparisons", () => {
      expect(brl("0").isZero()).toBe(true);
      expect(brl("0.01").isPositive()).toBe(true);
      expect(brl("1.00").negate().isNegative()).toBe(true);
      expect(brl("1.00").isLessThan(brl("1.01"))).toBe(true);
      expect(brl("1.00").isLessThan(brl("1.00"))).toBe(false);
      expect(brl("1.0").equals(brl("1.00"))).toBe(true);
      expect(brl("1.00").equals(usd("1.00"))).toBe(false);
    });
  });

  describe("currency", () => {
    test("operations across currencies throw a domain error", () => {
      expect(() => brl("1.00").add(usd("1.00"))).toThrow(CurrencyMismatchError);
      expect(() => brl("1.00").subtract(usd("1.00"))).toThrow(CurrencyMismatchError);
      expect(() => brl("1.00").isLessThan(usd("1.00"))).toThrow(CurrencyMismatchError);
    });
  });
});
