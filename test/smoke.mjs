/**
 * 冒烟测试：不联网、不碰 QQ，只验证插件契约。
 *
 *   node test/smoke.mjs
 *
 * 覆盖：
 *   1. 导出契约（name / inject / Config / apply）
 *   2. 缺 tools 服务时优雅降级、不抛错
 *   3. 注册出的工具定义可用（name / schema / execute）
 *   4. 参数与凭据缺失时的报错信息
 */
import assert from 'node:assert/strict';
import { apply, Config, inject, name } from '../index.js';

const silentLogger = { info() {}, warn() {}, debug() {}, error() {} };

function makeCtx() {
    const registered = [];
    return {
        registered,
        ctx: {
            logger: silentLogger,
            get: (service) => (service === 'tools' ? { register: (def) => registered.push(def) } : undefined),
        },
    };
}

// 1. 导出契约
assert.equal(name, 'qqbot-voice');
assert.deepEqual(inject, ['tools']);
assert.equal(typeof apply, 'function');
assert.equal(typeof Config, 'function');

// 2. 没有 tools 服务时不抛错
{
    let warned = false;
    apply({ logger: { ...silentLogger, warn: () => { warned = true; }, info() {} }, get: () => undefined }, Config({}));
    assert.equal(warned, true, '缺 tools 服务时应告警而非抛错');
}

// 3. 正常注册
const { ctx, registered } = makeCtx();
apply(ctx, Config({ apiKey: 'test-key', voice: 'default' }));
assert.equal(registered.length, 1, '应注册恰好一个工具');
const tool = registered[0];
assert.equal(tool.name, 'qqbot_send_voice');
assert.equal(tool.parameters.required[0], 'text');
assert.equal(typeof tool.execute, 'function');
assert.equal(typeof tool.output.render, 'function');

// 4. 入参与凭据校验
await assert.rejects(() => tool.execute({ text: '' }, {}), /不能为空/);
{
    const { ctx: bareCtx, registered: bare } = makeCtx();
    apply(bareCtx, Config({}));
    await assert.rejects(() => bare[0].execute({ text: '你好' }, {}), /API Key/);
}

console.log('smoke ok');
