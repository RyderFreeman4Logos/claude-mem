# OpenRouter 429 错误处理 - 模型内部轮询实现

## 功能概述

当 OpenRouter API 返回 429 错误（或其他配额相关错误）时，系统会在 OpenRouter provider 内部自动轮询优先级列表中的下一个模型，而不是立即切换到 Gemini 或 Claude provider。

## 实现细节

### 1. 配置方式

在 `~/.claude-mem/settings.json` 中配置模型优先级列表（逗号分隔）:

```json
{
  "CLAUDE_MEM_OPENROUTER_MODEL": "gemini-3-flash-preview,gemini-3-pro-preview,gemini-claude-sonnet-4-5"
}
```

**优先级顺序**: 从左到右，第一个模型优先级最高

### 2. 错误类型分类

系统区分三种可恢复错误，会触发 OpenRouter 内部模型轮询：

1. **429 错误**: HTTP 429 状态码或包含 "rate limit" / "too many requests"
2. **配额错误**: 包含 "quota" / "insufficient" / "credit"
3. **空响应**: 模型返回空内容

其他错误类型（如认证失败、网络错误）会立即抛出，不尝试其他模型。

### 3. Fallback 流程

```
请求 model[0]
  ↓
429/quota error?
  ↓ Yes
请求 model[1]
  ↓
429/quota error?
  ↓ Yes
请求 model[2]
  ↓
所有 OpenRouter 模型都失败?
  ↓ Yes
Fallback to Gemini (如果可用)
  ↓
Gemini 也失败?
  ↓ Yes
Fallback to Claude SDK
```

### 4. 日志记录

实现提供了详细的日志记录：

**启动时**（多个模型配置时）:
```
[INFO] OpenRouter configured with model priority list {
  models: "gemini-3-flash-preview → gemini-3-pro-preview → gemini-claude-sonnet-4-5",
  count: 3,
  note: "Will try models in order on 429/quota errors"
}
```

**模型切换时**:
```
[WARN] OpenRouter model failed (429 rate limit), trying next model in priority list {
  failedModel: "gemini-3-flash-preview",
  nextModel: "gemini-3-pro-preview",
  attemptNumber: 1,
  totalModels: 3,
  error: "..."
}
```

**成功回退时**:
```
[SUCCESS] OpenRouter model fallback successful {
  failedModels: "gemini-3-flash-preview, gemini-3-pro-preview",
  failedReasons: "429, quota",
  successModel: "gemini-claude-sonnet-4-5",
  attemptNumber: 3,
  totalModels: 3
}
```

**所有模型都失败时**:
```
[ERROR] All OpenRouter models in priority list failed {
  attemptedModels: "gemini-3-flash-preview, gemini-3-pro-preview, gemini-claude-sonnet-4-5",
  totalAttempts: 3,
  errors: "..."
}
```

### 5. 代码修改位置

**文件**: `src/services/worker/OpenRouterAgent.ts`

**主要修改**:

1. **错误检测逻辑** (第474-488行):
   - 分离了 429 错误和其他配额错误的检测
   - 添加 "too many requests" 关键词检测

2. **日志记录增强** (第460-479行, 496-503行):
   - 成功时记录失败原因分类
   - 切换时显示尝试次数和总模型数

3. **配置加载** (第675-681行):
   - 配置多个模型时自动打印优先级列表

4. **文档注释** (第1-19行):
   - 更新顶部注释说明 fallback 策略

## 测试建议

### 测试场景 1: 模拟 429 错误

1. 配置模型列表: `model-a,model-b,model-c`
2. 让 model-a 返回 429 错误
3. 验证系统自动尝试 model-b
4. 验证日志记录正确

### 测试场景 2: 所有模型都失败

1. 配置模型列表: `model-a,model-b`
2. 让所有模型都返回 429
3. 验证最终 fallback 到 Gemini
4. 验证错误日志包含所有尝试的模型

### 测试场景 3: 非可恢复错误

1. 配置模型列表: `model-a,model-b`
2. 让 model-a 返回认证错误（401）
3. 验证系统立即抛出错误，不尝试 model-b
4. 验证日志标记为 "non-recoverable error"

## 向后兼容性

✅ **完全兼容**: 如果 `CLAUDE_MEM_OPENROUTER_MODEL` 配置为单个模型（不含逗号），系统行为与之前完全相同。

```json
{
  "CLAUDE_MEM_OPENROUTER_MODEL": "gemini-3-flash-preview"
}
```

此时仍会在遇到 429 错误时 fallback 到 Gemini，但不会尝试其他 OpenRouter 模型。

## 性能影响

- **无额外开销**: 成功请求不会有任何性能影响
- **失败重试开销**: 每次模型切换会增加一次 API 请求时间
- **建议**: 配置 2-3 个模型为最佳，避免过长的重试链

## 相关文件

- `src/services/worker/OpenRouterAgent.ts` - 主实现
- `src/services/worker/agents/FallbackErrorHandler.ts` - 错误检测逻辑（未修改）
- `src/services/worker/agents/types.ts` - 错误模式定义（未修改）
- `~/.claude-mem/settings.json` - 用户配置
