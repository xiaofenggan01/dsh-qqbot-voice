/**
 * dsh-qqbot-voice — 给 QQ 机器人加一个「说话」工具。
 *
 * 工具名：`qqbot_send_voice({ text })`
 *   1. 调 VoxCPM（面壁 ModelBest，OpenAI 兼容 /v1/audio/speech）合成 WAV
 *   2. 可选：本地 ffmpeg 变声（pitchFactor，保时长）
 *   3. 落盘到 QQ 机器人允许投递的媒体目录，再用 `present` 声明为交付物
 *      —— qqbot 插件在轮末按扩展名投递，.wav 走语音消息通道
 *
 * 本插件不依赖 qqbot 的内部实现，只依赖两个公开契约：
 *   - `tools` 服务（注册工具、嵌套调用 present）
 *   - `present` 工具产出的 `deliverables/presented` 事件
 *
 * 配置：见 Config；apiKey 也可用环境变量 QQBOT_TTS_API_KEY 提供。
 */
import Schema from '@deepseek-ai/schemastery';
import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';

/** Cordis 插件名 */
export const name = 'qqbot-voice';

/** 依赖的宿主服务 */
export const inject = ['tools'];

/** 配置 */
export const Config = Schema.object({
    baseUrl: Schema.string().default('https://api.modelbest.cn').description('TTS 服务地址（OpenAI 兼容）'),
    apiKey: Schema.string().default('').description('API Key；留空则读环境变量 QQBOT_TTS_API_KEY'),
    model: Schema.string().default('VoxCPM2').description('语音合成模型'),
    voice: Schema.string().default('default').description('音色：default 或控制台音色库里的 voice_xxx'),
    maxChars: Schema.number().default(300).description('单条语音最长字数，超出截断'),
    pitchFactor: Schema.number().default(1).description('变声倍数：>1 升调，<1 降调，1 不变（需要宿主有 ffmpeg）'),
    refAudioPath: Schema.string().default('').description('参考音频（本地 WAV），提供时按零样本复刻合成'),
    present: Schema.boolean().default(true).description('合成后自动声明为交付物；关闭则只返回文件路径'),
    debug: Schema.boolean().default(false).description('调试日志'),
});

const TOOL_NAME = 'qqbot_send_voice';

const DESCRIPTION = 'Send a spoken voice message to the current QQ conversation: pass the text to say and it is '
    + 'synthesized (VoxCPM) and delivered as a QQ voice message. '
    + 'Use it whenever the user asks for a voice reply (「发语音」「语音说」「念一下」「用声音回」). '
    + 'Do not use qqbot_send_file for speech; that one only sends an existing audio file on disk.';

/** QQ 机器人允许投递的媒体目录（qqbot 的 sendFile 白名单根之一） */
const MEDIA_ROOT = join(homedir(), '.dsh-qqbot', 'media');

/** 正数兜底 */
function positive(value, fallback) {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** 解析 ffmpeg（env → PATH → Homebrew 常见路径） */
function resolveFfmpeg() {
    for (const candidate of [process.env.FFMPEG_PATH, 'ffmpeg', '/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg']) {
        if (!candidate)
            continue;
        if (candidate.includes('/') && !existsSync(candidate))
            continue;
        return candidate;
    }
    return undefined;
}

/** 从 SSE 帧里拼接 base64 音频分片 */
function collectSseAudio(frames) {
    const parts = [];
    for (const frame of frames) {
        for (const line of frame.split('\n')) {
            const trimmed = line.trimStart();
            if (!trimmed.startsWith('data:'))
                continue;
            const raw = trimmed.slice(5).trim();
            if (raw === '' || raw === '[DONE]')
                continue;
            let payload;
            try {
                payload = JSON.parse(raw);
            }
            catch {
                continue;
            }
            const b64 = payload?.audio ?? payload?.data?.audio ?? payload?.delta?.audio;
            if (typeof b64 === 'string' && b64.length > 0)
                parts.push(Buffer.from(b64, 'base64'));
        }
    }
    return parts.length > 0 ? Buffer.concat(parts) : null;
}

/** 调 TTS，返回 WAV Buffer */
async function synthesize(text, cfg) {
    const url = `${cfg.baseUrl.replace(/\/+$/, '')}/v1/audio/speech`;
    const body = { model: cfg.model, input: text, voice: cfg.voice || 'default' };
    if (cfg.refAudioPath && existsSync(cfg.refAudioPath)) {
        body.ref_audio = `data:audio/wav;base64,${readFileSync(cfg.refAudioPath).toString('base64')}`;
    }
    const res = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${cfg.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(120000),
    });
    if (!res.ok) {
        const detail = await res.text().catch(() => '');
        // 把平台的结构化错误翻成能直接行动的提示
        if (detail.includes('voice_not_found')) {
            throw new Error(`音色不存在（voice=${cfg.voice}）：可能已被删除、过期，或不属于当前 API Key。`
                + '去控制台「音色库」确认，或改用 voice: default + refAudioPath');
        }
        if (res.status === 401 || res.status === 403 || detail.includes('invalid_api_key')) {
            throw new Error(`TTS 鉴权失败（HTTP ${res.status}）：检查 apiKey 是否有效`);
        }
        throw new Error(`TTS HTTP ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`);
    }
    const contentType = (res.headers.get('content-type') ?? '').toLowerCase();
    if (!contentType.includes('text/event-stream')) {
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length === 0)
            throw new Error('TTS 返回空音频');
        return buf;
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    const frames = [];
    let pending = '';
    for (;;) {
        const { done, value } = await reader.read();
        if (done)
            break;
        pending += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = pending.indexOf('\n\n')) >= 0) {
            frames.push(pending.slice(0, idx));
            pending = pending.slice(idx + 2);
        }
    }
    if (pending.trim() !== '')
        frames.push(pending);
    const wav = collectSseAudio(frames);
    if (!wav || wav.length === 0)
        throw new Error('TTS 流式返回中没有音频数据');
    return wav;
}

/** 变声：asetrate 抬/降音调，atempo 反向补偿时长 */
async function applyPitch(wav, factor, logger) {
    if (!(factor > 0) || Math.abs(factor - 1) < 0.01)
        return wav;
    const ffmpeg = resolveFfmpeg();
    if (!ffmpeg) {
        logger?.warn?.('qqbot-voice: 未找到 ffmpeg，跳过变声');
        return wav;
    }
    const stamp = `${Date.now()}-${Math.round(Math.random() * 1000)}`;
    const src = join(MEDIA_ROOT, `.pitch-src-${stamp}.wav`);
    const dst = join(MEDIA_ROOT, `.pitch-dst-${stamp}.wav`);
    try {
        await mkdir(MEDIA_ROOT, { recursive: true });
        await writeFile(src, wav);
        const filter = `asetrate=48000*${factor},aresample=48000,atempo=${1 / factor}`;
        await new Promise((resolvePromise, rejectPromise) => {
            execFile(ffmpeg, ['-y', '-loglevel', 'error', '-i', src, '-af', filter, dst], (err, _out, stderr) => {
                if (err)
                    rejectPromise(new Error(String(stderr || err.message).slice(0, 200)));
                else
                    resolvePromise();
            });
        });
        return await readFile(dst);
    }
    catch (err) {
        logger?.warn?.(`qqbot-voice: 变声失败，使用原始音频: ${err instanceof Error ? err.message : String(err)}`);
        return wav;
    }
    finally {
        await rm(src, { force: true }).catch(() => { });
        await rm(dst, { force: true }).catch(() => { });
    }
}

/** WAV 时长（秒） */
function wavSeconds(buf) {
    try {
        if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF')
            return undefined;
        const byteRate = buf.readUInt32LE(28);
        if (byteRate <= 0)
            return undefined;
        return Math.round(((buf.length - 44) / byteRate) * 10) / 10;
    }
    catch {
        return undefined;
    }
}

/** 用 present 把文件声明为交付物（嵌套调用，宿主会折叠成 deliverables/presented） */
async function presentFile(tools, exec, filePath, logger) {
    try {
        const result = await tools.execute({
            callId: `call-voice-${Date.now()}`,
            name: 'present',
            arguments: { files: [{ path: filePath, description: '语音消息' }] },
            ...(exec?.agent !== undefined ? { agent: exec.agent } : {}),
            ...(exec?.signal !== undefined ? { signal: exec.signal } : {}),
        });
        if (logger.debug)
            logger.debug?.(`qqbot-voice: present -> ${JSON.stringify(result).slice(0, 200)}`);
        return true;
    }
    catch (err) {
        logger?.warn?.(`qqbot-voice: present 调用失败（可让模型自行调用 present）: ${err instanceof Error ? err.message : String(err)}`);
        return false;
    }
}

export function apply(ctx, config) {
    const logger = ctx.logger ?? console;
    const tools = ctx.get('tools');
    if (!tools?.register) {
        logger.warn?.('qqbot-voice: tools 服务不可用，qqbot_send_voice 未注册');
        return;
    }
    // 装完还没配凭据时给出明确指引（不阻断加载）
    if (!config?.apiKey && !process.env.QQBOT_TTS_API_KEY) {
        logger.warn?.('qqbot-voice: 尚未配置 apiKey —— 在 profile 的 cordis.patch.yml 里给 qqbot-voice 加 '
            + '`apiKey: sk-xxx`（或设置环境变量 QQBOT_TTS_API_KEY），否则调用会失败');
    }
    const definition = {
        name: TOOL_NAME,
        description: DESCRIPTION,
        parameters: {
            type: 'object',
            properties: {
                text: { type: 'string', description: '要念出来的文字（口语化、简短；超过 maxChars 会被截断）。' },
            },
            required: ['text'],
            additionalProperties: false,
        },
        output: {
            schema: {
                type: 'object',
                properties: {
                    fileName: { type: 'string' },
                    fileSize: { type: 'integer' },
                    path: { type: 'string' },
                    seconds: { type: 'number' },
                    delivered: { type: 'boolean' },
                },
                required: ['fileName', 'fileSize', 'path', 'delivered'],
                additionalProperties: false,
            },
            render: (_args, value) => {
                const v = value;
                return [{
                    type: 'text',
                    text: v.delivered
                        ? `已发送语音 ${v.fileName}（${v.seconds ?? '?'}s）`
                        : `已生成语音 ${v.fileName}（${v.seconds ?? '?'}s，路径 ${v.path}）——请调用 present 发送它`,
                }];
            },
        },
        async execute(args, exec) {
            const { text } = args;
            if (typeof text !== 'string' || text.trim() === '')
                throw new Error('qqbot_send_voice: `text` 不能为空');
            const apiKey = config.apiKey || process.env.QQBOT_TTS_API_KEY || '';
            if (!apiKey)
                throw new Error('qqbot_send_voice: 未配置 API Key（config.apiKey 或环境变量 QQBOT_TTS_API_KEY）');
            const cfg = {
                baseUrl: config.baseUrl || 'https://api.modelbest.cn',
                apiKey,
                model: config.model || 'VoxCPM2',
                voice: config.voice || 'default',
                refAudioPath: config.refAudioPath || '',
            };
            let spoken = text.trim();
            const maxChars = positive(config.maxChars, 300);
            if (spoken.length > maxChars)
                spoken = `${spoken.slice(0, maxChars)}…`;

            let wav = await synthesize(spoken, cfg);
            wav = await applyPitch(wav, positive(config.pitchFactor, 1), logger);

            await mkdir(MEDIA_ROOT, { recursive: true });
            const filePath = join(MEDIA_ROOT, `tts-${Date.now()}.wav`);
            await writeFile(filePath, wav);

            let delivered = false;
            if (config.present !== false)
                delivered = await presentFile(tools, exec, filePath, logger);

            const seconds = wavSeconds(wav);
            logger.info?.(`qqbot-voice: 合成 ${basename(filePath)} (${wav.length} bytes${seconds ? `, ${seconds}s` : ''}) delivered=${delivered}`);
            return {
                fileName: basename(filePath),
                fileSize: wav.length,
                path: filePath,
                delivered,
                ...(seconds !== undefined ? { seconds } : {}),
            };
        },
    };
    tools.register(definition);
    logger.info?.('qqbot-voice: qqbot_send_voice 工具已注册');
}
