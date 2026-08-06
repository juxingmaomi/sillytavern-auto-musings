import crypto from 'node:crypto';

const CJK_PATTERN = /[\u3400-\u9fff]/;
const ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{7,79}$/;
const STOP_WORDS = new Set([
    '一个', '一些', '这个', '那个', '什么', '怎么', '就是', '因为', '所以', '但是', '然后', '还是', '已经',
    '可以', '可能', '觉得', '没有', '不是', '自己', '我们', '你们', '他们', '以及', '如果', '时候', '东西',
    'the', 'and', 'for', 'that', 'this', 'with', 'from', 'have', 'not', 'are', 'was', 'you', 'your', 'they',
]);

function clamp(value, min, max, fallback) {
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    return Math.min(max, Math.max(min, number));
}

function normalizeText(value, limit = 120_000) {
    return String(value ?? '')
        .normalize('NFKC')
        .replace(/\u0000/g, '')
        .replace(/\r\n?/g, '\n')
        .trim()
        .slice(0, limit);
}

function collectErrorChain(error) {
    const messages = [];
    const seen = new Set();
    let current = error;

    while (current && !seen.has(current) && messages.length < 6) {
        seen.add(current);
        const message = typeof current?.message === 'string'
            ? current.message
            : (typeof current === 'string' ? current : '');
        if (message && !messages.includes(message)) messages.push(message);
        current = current?.cause;
    }

    if (messages.length === 0) messages.push(String(error || '未知错误'));
    return messages.join(' <- ');
}

function findErrorDetail(error, candidates) {
    const seen = new Set();
    let current = error;

    while (current && !seen.has(current)) {
        seen.add(current);
        for (const candidate of candidates) {
            const value = candidate(current);
            if (value !== undefined && value !== null && String(value).trim()) return value;
        }
        current = current?.cause;
    }

    return '';
}

function walkStructuredIds(value, output, seen = new Set()) {
    if (!value || typeof value !== 'object' || seen.has(value)) return;
    seen.add(value);

    if (Array.isArray(value)) {
        for (const item of value) walkStructuredIds(item, output, seen);
        return;
    }

    const looksLikePost = [value.title, value.content, value.content_preview, value.submolt, value.post_type]
        .some((item) => typeof item === 'string' && item.trim());
    const candidates = [value.post_id, looksLikePost ? value.id : null];
    for (const candidate of candidates) {
        const id = String(candidate ?? '').trim();
        if (ID_PATTERN.test(id)) output.push(id);
    }

    for (const child of Object.values(value)) walkStructuredIds(child, output, seen);
}

export function extractMcpText(result) {
    const blocks = [];
    const content = Array.isArray(result?.content)
        ? result.content
        : (Array.isArray(result?.result?.content) ? result.result.content : []);

    for (const item of content) {
        if (typeof item === 'string') blocks.push(item);
        else if (item?.type === 'text' && typeof item.text === 'string') blocks.push(item.text);
        else if (item?.type === 'resource' && typeof item.resource?.text === 'string') blocks.push(item.resource.text);
    }

    if (blocks.length === 0 && typeof result === 'string') blocks.push(result);
    return normalizeText(blocks.join('\n\n'));
}

export function extractForumPostIds(result, limit = 30) {
    const ids = [];
    walkStructuredIds(result?.structuredContent ?? result?.result?.structuredContent, ids);

    const text = extractMcpText(result);
    const patterns = [
        /(?:post(?:_id)?|帖子(?:\s*ID)?|文章(?:\s*ID)?|贴子(?:\s*ID)?)\s*[:：#]?\s*[`"']?([a-zA-Z0-9][a-zA-Z0-9_-]{7,79})/gi,
        /(?:cli\s*\(\s*command\s*=\s*["']show\s+|\bshow\s+)([a-zA-Z0-9][a-zA-Z0-9_-]{7,79})/gi,
        /\/posts\/([a-zA-Z0-9][a-zA-Z0-9_-]{7,79})/gi,
        /\b([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\b/gi,
        /\b([0-9a-f]{20,64})\b/gi,
    ];

    for (const pattern of patterns) {
        for (const match of text.matchAll(pattern)) ids.push(match[1]);
    }

    return [...new Set(ids.map((id) => id.trim()).filter((id) => ID_PATTERN.test(id)))].slice(0, limit);
}

function findField(text, labels) {
    for (const label of labels) {
        const pattern = new RegExp(`(?:^|\\n)\\s*(?:${label})\\s*[:：]\\s*([^\\n]+)`, 'i');
        const match = text.match(pattern);
        if (match?.[1]) return match[1].trim().replace(/^[-*#\s]+/, '');
    }
    return '';
}

export function buildForumPost(id, result) {
    const text = extractMcpText(result);
    return {
        id: String(id || '').trim(),
        title: findField(text, ['标题', 'title']) || text.split('\n').find((line) => line.trim())?.trim().slice(0, 300) || `帖子 ${id}`,
        author: findField(text, ['作者', 'author', '发帖人']),
        submolt: findField(text, ['板块', 'submolt', '分区']),
        text: text.slice(0, 24_000),
        excerpt: text.replace(/\s+/g, ' ').slice(0, 1_600),
    };
}

function getFeatures(value) {
    const text = normalizeText(value, 200_000).toLowerCase();
    const words = new Set();
    const cjk = [...text].filter((character) => CJK_PATTERN.test(character));

    for (const match of text.matchAll(/[a-z0-9][a-z0-9_./+-]{1,39}/g)) {
        if (!STOP_WORDS.has(match[0])) words.add(`w:${match[0]}`);
    }
    for (const match of text.matchAll(/[\u3400-\u9fff]{2,12}/g)) {
        const phrase = match[0];
        if (!STOP_WORDS.has(phrase)) words.add(`p:${phrase}`);
    }
    for (let index = 0; index < cjk.length - 1; index += 1) {
        words.add(`c:${cjk[index]}${cjk[index + 1]}`);
        if (words.size >= 6_000) break;
    }
    return words;
}

export function calculateTextAffinity(left, right) {
    const leftFeatures = getFeatures(left);
    const rightFeatures = getFeatures(right);
    if (leftFeatures.size === 0 || rightFeatures.size === 0) return 0;

    let hits = 0;
    const [small, large] = leftFeatures.size <= rightFeatures.size
        ? [leftFeatures, rightFeatures]
        : [rightFeatures, leftFeatures];
    for (const feature of small) {
        if (large.has(feature)) hits += feature.startsWith('p:') ? 2 : 1;
    }
    return clamp(hits / Math.max(8, Math.min(80, small.size)), 0, 1, 0);
}

function normalizeRawScore(value, scale = 5) {
    const score = Number(value);
    if (!Number.isFinite(score) || score <= 0) return 0;
    if (score <= 1) return score;
    return score / (score + scale);
}

export function summarizeAnimaEvidence(response) {
    const vectorItems = Array.isArray(response?.vector_chat_results)
        ? response.vector_chat_results
        : (Array.isArray(response?.merged_chat_results)
            ? response.merged_chat_results.filter((item) => item?.type !== 'bm25')
            : []);
    const bm25Items = Array.isArray(response?.bm25_chat_results)
        ? response.bm25_chat_results
        : (Array.isArray(response?.merged_chat_results)
            ? response.merged_chat_results.filter((item) => item?.type === 'bm25')
            : []);

    const vectorScore = vectorItems.reduce((best, item) => Math.max(
        best,
        normalizeRawScore(item?.rerank_score ?? item?._rerank_score ?? item?.score, 3),
    ), 0);
    const bm25Score = bm25Items.reduce((best, item) => Math.max(best, normalizeRawScore(item?.score, 5)), 0);
    const score = vectorScore > 0 && bm25Score > 0
        ? Math.max(vectorScore, bm25Score, vectorScore * 0.65 + bm25Score * 0.35)
        : Math.max(vectorScore, bm25Score);

    const excerpts = [...vectorItems, ...bm25Items]
        .sort((left, right) => Number(right?.score || 0) - Number(left?.score || 0))
        .map((item) => normalizeText(item?.text, 1_200))
        .filter(Boolean)
        .filter((item, index, list) => list.indexOf(item) === index)
        .slice(0, 4);

    return { score: clamp(score, 0, 1, 0), vectorScore, bm25Score, excerpts };
}

export function rankForumPosts(posts, context = {}) {
    const chatText = normalizeText(context.chatText, 240_000);
    const seedText = Array.isArray(context.seedWords) ? context.seedWords.join('\n') : normalizeText(context.seedWords);
    const musingText = normalizeText(context.musingText, 20_000);

    return posts.map((post) => {
        const memory = summarizeAnimaEvidence(post.animaResponse);
        const chatScore = calculateTextAffinity(post.text, chatText);
        const seedScore = calculateTextAffinity(post.text, seedText);
        const musingScore = calculateTextAffinity(post.text, musingText);
        const relevanceScore = clamp(
            memory.score * 0.45 + chatScore * 0.30 + seedScore * 0.15 + musingScore * 0.10,
            0,
            1,
            0,
        );
        return {
            ...post,
            memory,
            scores: { memory: memory.score, chat: chatScore, seed: seedScore, musing: musingScore, relevance: relevanceScore },
        };
    }).sort((left, right) => right.scores.relevance - left.scores.relevance);
}

export function createSeededRandom(seed) {
    const digest = crypto.createHash('sha256').update(String(seed || '')).digest();
    let state = digest.readUInt32LE(0) || 0x9e3779b9;
    return () => {
        state ^= state << 13;
        state ^= state >>> 17;
        state ^= state << 5;
        return (state >>> 0) / 0x1_0000_0000;
    };
}

export function selectForumPosts(rankedPosts, options = {}) {
    const count = Math.round(clamp(options.count, 1, 10, 3));
    const relatedRatio = clamp(options.relatedRatio, 0, 100, 70);
    const relatedCount = Math.min(count, Math.max(0, Math.round(count * relatedRatio / 100)));
    const selected = rankedPosts.slice(0, relatedCount).map((post) => ({ ...post, lane: 'related' }));
    const selectedIds = new Set(selected.map((post) => post.id));
    const exploration = rankedPosts.filter((post) => !selectedIds.has(post.id));
    const random = typeof options.random === 'function' ? options.random : Math.random;

    while (selected.length < count && exploration.length > 0) {
        const index = Math.floor(random() * exploration.length);
        selected.push({ ...exploration.splice(index, 1)[0], lane: 'explore' });
    }
    return selected;
}

export function redactSecrets(value) {
    let text = normalizeText(value, 8_000);
    text = text.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [已隐藏]');
    text = text.replace(/Basic\s+[A-Za-z0-9+/=]+/gi, 'Basic [已隐藏]');
    text = text.replace(/\bAIza[A-Za-z0-9_-]{20,}\b/g, '[API Key 已隐藏]');
    text = text.replace(/\b(?:sk|rk|pk|gsk|ghp|github_pat|xai|sess)[-_][A-Za-z0-9_-]{8,}\b/gi, '[API Key 已隐藏]');
    text = text.replace(/((?:["']?(?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|authorization|x-api-key|secret|password)["']?\s*[:=]\s*["']?))([^"'\s,}\]]{6,})/gi, '$1[已隐藏]');
    text = text.replace(/([?&](?:token|key|api_key|access_token)=)[^&\s]+/gi, '$1[已隐藏]');
    text = text.replace(/https?:\/\/[^\s"']+/gi, (urlText) => {
        try {
            return `[地址已隐藏:${new URL(urlText).host}]`;
        } catch {
            return '[地址已隐藏]';
        }
    });
    return text;
}

function getErrorStatus(error) {
    const value = findErrorDetail(error, [
        (item) => item?.status,
        (item) => item?.statusCode,
        (item) => item?.httpStatus,
        (item) => item?.response?.status,
    ]);
    const status = Number(value);
    return Number.isFinite(status) && status > 0 ? status : null;
}

export function createReadableDiagnostic(error, context = {}) {
    const stage = String(context.stage || 'unknown');
    const status = getErrorStatus(error);
    const rawMessage = redactSecrets(collectErrorChain(error));
    const lower = rawMessage.toLowerCase();
    const systemCode = redactSecrets(findErrorDetail(error, [
        (item) => item?.code,
        (item) => item?.errno,
    ]));
    const providerCode = redactSecrets(findErrorDetail(error, [
        (item) => item?.providerCode,
        (item) => item?.data?.error?.code,
        (item) => item?.response?.data?.error?.code,
    ]));
    const providerType = redactSecrets(findErrorDetail(error, [
        (item) => item?.providerType,
        (item) => item?.data?.error?.type,
        (item) => item?.response?.data?.error?.type,
    ]));
    const requestId = redactSecrets(findErrorDetail(error, [
        (item) => item?.requestId,
        (item) => item?.response?.headers?.['x-request-id'],
    ]));
    const stageNames = {
        mcp_status: '检查论坛连接',
        forum_discover: '获取论坛候选帖子',
        forum_show: '读取帖子正文',
        anima_query: '检索小克的 Anima 记忆',
        gemini_filter: 'Gemini 垃圾过滤',
        claude_review: '小克阅读并判断帖子',
        prompt_snapshot: '读取酒馆完整上下文',
        hidden_musing: '生成隐藏漫想',
        visible_musing: '生成发送到聊天的漫想',
        worldbook_write: '写入世界书',
        musing_cycle: '执行后台漫想周期',
        server_sync: '同步服务端状态',
        server_bridge: '连接后台漫想服务',
    };

    let code = 'unknown_error';
    let title = '出现了未识别的错误';
    let summary = normalizeText(context.summary, 2_000) || '当前步骤没有完成，错误已经记录。';
    let action = '把这条诊断复制给猴猴，我会根据技术详情继续定位。';

    if (stage === 'server_bridge' && /version|版本/.test(lower)) {
        code = 'server_version_mismatch';
        title = '前端和后台漫想服务版本不一致';
        summary = '为了避免新旧代码互相误解，当前页面不会调用旧版后台接口。';
        action = '现在不用重启；等你方便停止游玩时再重启一次酒馆，让新版后台服务生效。';
    } else if (stage === 'prompt_snapshot' && /no complete|snapshot|上下文/.test(lower)) {
        code = 'prompt_snapshot_missing';
        title = '还没有捕获到小克的完整酒馆上下文';
        summary = '论坛帖子已经保留，但 Claude 暂时不能在缺少角色卡、世界书和当前对话的情况下继续判断。';
        action = '在小克聊天里正常发送一条消息，等回复完成后点“重试上次失败任务”。';
    } else if (/尚未选择|connection profile/.test(lower)) {
        code = 'profile_missing';
        title = '尚未选择这一阶段使用的 API 配置';
        summary = '插件没有拿到明确的连接配置，因此没有向任何模型发送请求。';
        action = '在 Auto Musings 面板选择对应连接配置和模型名，然后手动重试。';
    } else if (systemCode === 'secret_not_found' || /api key.*(?:不存在|找不到|不可读取)|没有找到.*api key|secret.*not found/.test(lower)) {
        code = 'secret_not_found';
        title = '所选连接配置绑定的 API Key 不可用';
        summary = '插件只查找该配置明确绑定的 Key；没有找到后立即停止，没有尝试其他 Key。';
        action = '打开对应酒馆连接配置，重新选择或保存正确的 Key；插件不会改用其他 Key。';
    } else if (/只支持 custom|does not support|unsupported profile/.test(lower)) {
        code = 'unsupported_profile';
        title = '所选连接配置不是当前后台支持的类型';
        summary = '第一版后台无法按这种连接类型构造请求，因此没有调用模型。';
        action = '第一版后台只接受“自定义（兼容 OpenAI）”连接配置；换成对应配置后手动重试。';
    } else if (['mcp_status', 'forum_discover', 'forum_show'].includes(stage) && lower.includes('disabled')) {
        code = 'tool_disabled';
        title = '论坛读取工具尚未启用';
        summary = '插件遵守了 MCP 权限设置，没有尝试绕过禁用状态。';
        action = '准备测试时只启用 cli 即可；presence_* 可以继续保持关闭。';
    } else if (lower.includes('not found') && lower.includes('mcp')) {
        code = 'mcp_not_found';
        title = '没有找到论坛 MCP 配置';
        summary = '酒馆后台没有找到指定名称的论坛连接，因此论坛流程没有开始读取。';
        action = '确认 MCP 面板里仍有名为 lutopia 的服务器，然后点“重试上次任务”。';
    } else if (stage === 'worldbook_write' && /世界书|world.?book|world info/.test(lower)) {
        code = 'worldbook_write_failed';
        title = '隐藏漫想已生成，但没有写进世界书';
        summary = '模型调用已经成功，失败发生在保存角色世界书这一步。';
        action = '先不要清空漫想日志；完整念头仍在日志里。把诊断复制给猴猴定位世界书名称或文件问题。';
    } else if (stage === 'forum_show' && status === 404) {
        code = 'forum_post_missing';
        title = '这篇论坛帖子已经不存在或暂时无法读取';
        action = '不需要切换 API；插件会继续处理同批其他帖子。';
    } else if (status === 401 || status === 403 || /unauthor|forbidden|api key|authentication/.test(lower)) {
        code = 'authentication_failed';
        title = 'API 身份验证失败';
        summary = '目标接口拒绝了当前连接配置的身份凭证，本次没有得到模型回复。';
        action = '在酒馆连接配置里检查对应配置的密钥是否仍有效，再手动重试。';
    } else if (status === 404 || /model.*not found|unknown model|不存在.*模型/.test(lower)) {
        code = 'endpoint_or_model_missing';
        title = '接口地址或模型名不被服务端识别';
        summary = '请求已经到达服务端，但服务端找不到这个接口路径或模型名称。';
        action = '检查所选连接配置和模型名；修改后点“测试”或“重试上次任务”。';
    } else if (status === 429 || /rate.?limit|too many|quota|额度|限流/.test(lower)) {
        code = 'rate_limited';
        title = 'API 请求过多或额度受限';
        summary = '服务端暂时拒绝继续处理请求，常见原因是频率限制、并发限制或额度不足。';
        action = '稍后再手动重试，或者在面板里换成你想用的连接配置。';
    } else if (status >= 500 || /bad gateway|service unavailable|upstream/.test(lower)) {
        code = 'provider_unavailable';
        title = 'API 服务端暂时异常';
        summary = '错误来自目标服务或它的上游，不是插件自动更换了 API。';
        action = '不用改配置，等服务恢复后手动重试即可。';
    } else if (status === 413 || /context length|too large|payload.*large|上下文.*过长/.test(lower)) {
        code = 'request_too_large';
        title = '发送给模型的内容超过了接口限制';
        action = '减少论坛单次帖子数或上下文量后手动重试；插件不会擅自删减后再次发送。';
    } else if (status === 400 || status === 422 || /invalid request|bad request/.test(lower)) {
        code = 'invalid_request';
        title = '接口不接受这次请求格式';
        action = '把完整诊断复制给猴猴；我会根据服务端错误码调整请求格式。';
    } else if (error?.name === 'AbortError' || /timeout|timed out|超时/.test(lower)) {
        code = 'timeout';
        title = '请求超时';
        summary = '在设定时间内没有收到完整回复，插件已中止这一次请求。';
        action = '检查网络或反代是否正常；任务已保留，可以稍后重试。';
    } else if (/fetch failed|network|econn|socket|连接|dns/.test(lower)) {
        code = 'network_error';
        title = '无法连接到目标服务';
        summary = '酒馆服务器没有成功建立或维持到目标接口的网络连接。';
        action = '检查服务器网络、反代或 MCP 连接状态，然后手动重试。';
    } else if (/empty|空内容|没有返回/.test(lower)) {
        code = 'empty_response';
        title = '模型返回了空内容';
        summary = '接口请求完成了，但可用的模型正文为空，所以插件没有伪造结果。';
        action = '先点一次对应 API 的测试；若仍为空，把诊断复制给猴猴。';
    } else if (/json|格式|parse|unexpected token/.test(lower)) {
        code = 'invalid_response_format';
        title = '模型返回的格式无法读取';
        summary = '接口有返回内容，但不是插件能够安全解析的标准结构。';
        action = '原始回复摘要已保留；把诊断复制给猴猴，我会调整解析规则。';
    } else if (/anima.*not initialized|anima.*unavailable|query service/.test(lower)) {
        code = 'anima_unavailable';
        title = 'Anima 记忆服务尚未就绪';
        action = '无需重建记忆库；下次允许重启酒馆后加载新接口，再手动重试。';
    }

    return {
        id: crypto.randomUUID(),
        kind: 'diagnostic',
        ts: Date.now(),
        severity: context.severity || 'error',
        code,
        stage,
        stageName: stageNames[stage] || stage,
        title,
        summary,
        impact: context.impact || '本次步骤停止；不会自动切换 API，也不会自动发帖或回帖。',
        preservation: normalizeText(context.preservation, 2_000) || '故障诊断已经写入持久日志。',
        retry: normalizeText(context.retry, 2_000) || '不会自动重试；处理建议中的问题后再由你手动重试。',
        automaticApiSwitch: false,
        action,
        technical: {
            status,
            profileName: normalizeText(context.profileName, 300),
            model: normalizeText(context.model, 500),
            operationId: normalizeText(context.operationId, 200),
            endpointHost: redactSecrets(context.endpointHost || error?.endpointHost || ''),
            errorName: normalizeText(error?.name, 120),
            systemCode: normalizeText(systemCode, 200),
            providerCode: normalizeText(providerCode, 300),
            providerType: normalizeText(providerType, 300),
            requestId: normalizeText(requestId, 300),
            message: rawMessage,
            responseExcerpt: redactSecrets(context.responseExcerpt || error?.responseExcerpt || ''),
        },
    };
}
