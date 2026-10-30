export const CLIENT_VERSION_HEADER = "X-Pocket-Client-Version";

// Production injects the existing frontend build hash. A missing Node/dev
// constant or malformed build label must never make an otherwise valid fetch
// fail header validation. This value is diagnostic, not an access/version gate.
const build = typeof __POCKET_BUILD_ID__ === "string" ? __POCKET_BUILD_ID__ : "development";
export const CLIENT_VERSION = /^[a-z0-9][a-z0-9._+-]{0,159}$/i.test(build) ? build : "development";

export function clientVersionHeaders() {
  return { [CLIENT_VERSION_HEADER]: CLIENT_VERSION };
}
