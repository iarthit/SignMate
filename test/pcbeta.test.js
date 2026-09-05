import assert from "node:assert/strict";
import test from "node:test";
import { isPCBetaSecurityChallenge } from "../src/drivers/pcbeta.js";

test("recognizes PCBeta's IP security challenge without treating it as a cookie failure", () => {
  const page = "异常请求验证 请求异常，请完成安全验证后继续访问。拖动滑块验证";
  assert.equal(isPCBetaSecurityChallenge(page, "异常请求验证"), true);
  assert.equal(isPCBetaSecurityChallenge("请启用 JavaScript 后重试", ""), true);
  assert.equal(isPCBetaSecurityChallenge("任务 - 远景论坛 | RyuHwang | 退出", "任务 - 远景论坛"), false);
});
