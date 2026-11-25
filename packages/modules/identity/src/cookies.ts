/** Session cookies. Secure stays on even when the local URL is http. */
export const sessionCookieAttributes = {
  httpOnly: true,
  secure: true,
  sameSite: "lax",
} as const;
