import { expect, test } from "bun:test";
import { typePassword } from "./prompt.ts";

test("typing builds the password, and Enter finishes it", () => {
  expect(typePassword("", "pass")).toEqual({ password: "pass" });
  expect(typePassword("pass", "word\r")).toEqual({ password: "password", done: "enter" });
  expect(typePassword("", "a\nignored")).toEqual({ password: "a", done: "enter" });
});

test("backspace removes one character, even a non-ASCII one", () => {
  expect(typePassword("abc", "\u007f")).toEqual({ password: "ab" });
  expect(typePassword("añ", "\b")).toEqual({ password: "a" });
  expect(typePassword("", "\u007f")).toEqual({ password: "" });
});

test("Ctrl-C cancels; Ctrl-D cancels only an empty line", () => {
  expect(typePassword("secret", "\u0003")).toEqual({ password: "", done: "cancel" });
  expect(typePassword("", "\u0004")).toEqual({ password: "", done: "cancel" });
  expect(typePassword("x", "\u0004")).toEqual({ password: "x" });
});

test("other control characters, such as arrow keys' escapes, are dropped", () => {
  expect(typePassword("", "a\u001b[Db")).toEqual({ password: "a[Db" });
  expect(typePassword("", "\t")).toEqual({ password: "" });
});
