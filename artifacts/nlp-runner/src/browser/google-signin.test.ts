import { describe, expect, it } from "vitest";
import {
  detectGoogleSignIn,
  isGoogleSignInUrl,
  mentionsGoogleSignIn,
} from "./google-signin.js";

describe("mentionsGoogleSignIn", () => {
  it("detects 'sign in with google' phrasings", () => {
    expect(mentionsGoogleSignIn("sign in to fino finance with google")).toBe(true);
    expect(mentionsGoogleSignIn("Sign in using Google")).toBe(true);
    expect(mentionsGoogleSignIn("log in with google account")).toBe(true);
    expect(mentionsGoogleSignIn("login via google")).toBe(true);
    expect(mentionsGoogleSignIn("google sign-in")).toBe(true);
  });

  it("detects 'sign up with google' phrasings", () => {
    expect(mentionsGoogleSignIn("sign up with google")).toBe(true);
    expect(mentionsGoogleSignIn("create an account using continue with google")).toBe(true);
    expect(mentionsGoogleSignIn("register on the site via google oauth")).toBe(true);
  });

  it("detects the 'Continue with Google' button phrase", () => {
    expect(
      mentionsGoogleSignIn(
        "sign in to fino finance using Continue with Google button, email finofinancetesting@gmail.com",
      ),
    ).toBe(true);
  });

  it("rejects plain google references with no sign-in intent", () => {
    expect(mentionsGoogleSignIn("search for google news")).toBe(false);
    expect(mentionsGoogleSignIn("what is google")).toBe(false);
    expect(mentionsGoogleSignIn("find the google blog")).toBe(false);
    expect(mentionsGoogleSignIn("")).toBe(false);
  });

  it("rejects non-google sign-in mentions", () => {
    expect(mentionsGoogleSignIn("sign in to the dashboard")).toBe(false);
    expect(mentionsGoogleSignIn("log in with github")).toBe(false);
  });
});

describe("isGoogleSignInUrl", () => {
  it("matches accounts.google.com and its OAuth variants", () => {
    expect(isGoogleSignInUrl("https://accounts.google.com/v3/signin/identifier")).toBe(true);
    expect(isGoogleSignInUrl("https://accounts.google.com/o/oauth2/auth?client_id=x")).toBe(true);
    expect(isGoogleSignInUrl("https://accounts.google.cn/ServiceLogin")).toBe(true);
  });

  it("matches google.com sign-in paths", () => {
    expect(isGoogleSignInUrl("https://www.google.com/signin/v2/identifier")).toBe(true);
    expect(isGoogleSignInUrl("https://accounts.google.com/accountchooser")).toBe(true);
  });

  it("rejects non sign-in google URLs and other sites", () => {
    expect(isGoogleSignInUrl("https://www.google.com/search?q=hello")).toBe(false);
    expect(isGoogleSignInUrl("https://www.fino.finance/auth")).toBe(false);
    expect(isGoogleSignInUrl("https://github.com/login")).toBe(false);
    expect(isGoogleSignInUrl("")).toBe(false);
  });
});

describe("detectGoogleSignIn", () => {
  it("is true when the query mentions google sign-in", () => {
    expect(detectGoogleSignIn({ query: "sign up with google" })).toBe(true);
  });

  it("is true when the entry URL is a Google sign-in page", () => {
    expect(
      detectGoogleSignIn({ url: "https://accounts.google.com/v3/signin/identifier" }),
    ).toBe(true);
  });

  it("is false when nothing indicates a Google sign-in", () => {
    expect(detectGoogleSignIn({ query: "buy a book", url: "https://www.fino.finance/auth" })).toBe(false);
    expect(detectGoogleSignIn({})).toBe(false);
  });
});
