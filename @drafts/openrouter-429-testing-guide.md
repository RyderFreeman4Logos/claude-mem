# OpenRouter 429 模型轮询 - 测试验证指南

## 当前配置验证

```bash
# 查看当前配置的模型优先级列表
cat ~/.claude-mem/settings.json | jq -r '.CLAUDE_MEM_OPENROUTER_MODEL'
```

**当前配置**: `gemini-3-flash-preview,gemini-3-pro-preview,gemini-claude-sonnet-4-5`

## 预期行为

### 场景 1: 第一个模型成功

```
Request: gemini-3-flash-preview
  ↓
✓ Success (200)
  ↓
[DEBUG] OpenRouter first model succeeded {
  model: "gemini-3-flash-preview",
  totalModels: 3
}
```

### 场景 2: 第一个模型遇到 429，第二个成功

```
Request: gemini-3-flash-preview
  ↓
✗ 429 Rate Limit
  ↓
[WARN] OpenRouter model failed (429 rate limit), trying next model in priority list {
  failedModel: "gemini-3-flash-preview",
  nextModel: "gemini-3-pro-preview",
  attemptNumber: 1,
  totalModels: 3
}
  ↓
Request: gemini-3-pro-preview
  ↓
✓ Success (200)
  ↓
[SUCCESS] OpenRouter model fallback successful {
  failedModels: "gemini-3-flash-preview",
  failedReasons: "429",
  successModel: "gemini-3-pro-preview",
  attemptNumber: 2,
  totalModels: 3
}
```

### 场景 3: 所有 OpenRouter 模型都失败 → Fallback to Gemini

```
Request: gemini-3-flash-preview
  ↓
✗ 429 Rate Limit
  ↓
Request: gemini-3-pro-preview
  ↓
✗ Quota Exhausted
  ↓
Request: gemini-claude-sonnet-4-5
  ↓
✗ 429 Rate Limit
  ↓
[ERROR] All OpenRouter models in priority list failed {
  attemptedModels: "gemini-3-flash-preview, gemini-3-pro-preview, gemini-claude-sonnet-4-5",
  totalAttempts: 3
}
  ↓
[WARN] All OpenRouter models failed, falling back to Gemini
  ↓
Try Gemini provider...
```

### 场景 4: 遇到非可恢复错误（立即抛出）

```
Request: gemini-3-flash-preview
  ↓
✗ 401 Unauthorized
  ↓
[ERROR] OpenRouter encountered non-recoverable error, not trying other models {
  failedModel: "gemini-3-flash-preview",
  error: "401 Unauthorized..."
}
  ↓
Throw Error (不尝试其他模型)
  ↓
[WARN] OpenRouter API failed, falling back to Claude SDK
```

## 手动测试步骤

### 1. 查看启动日志

重启 worker 服务，观察配置加载日志：

```bash
# 方法1: 查看实时日志
tail -f ~/.claude-mem/logs/worker.log | grep -A 5 "OpenRouter configured"

# 方法2: 触发 session 开始
# 在 Claude Code 中进行任何操作，观察日志输出
```

**预期输出**:
```
[INFO] OpenRouter configured with model priority list {
  models: "gemini-3-flash-preview → gemini-3-pro-preview → gemini-claude-sonnet-4-5",
  count: 3,
  note: "Will try models in order on 429/quota errors"
}
```

### 2. 模拟 429 错误（可选）

如果需要强制测试 429 错误处理，可以暂时修改代码：

```typescript
// 在 queryOpenRouterMultiTurn 方法中添加模拟逻辑
if (model === 'gemini-3-flash-preview') {
  throw new Error('OpenRouter API error: 429 - Rate limit exceeded');
}
```

### 3. 观察真实场景

在正常使用过程中，如果遇到 429 错误：

1. 检查日志中是否有 "trying next model in priority list"
2. 验证系统是否尝试了配置列表中的下一个模型
3. 确认只在所有 OpenRouter 模型都失败后才 fallback 到 Gemini

## 验证清单

- [ ] 编译成功无错误
- [ ] 启动时打印配置的模型优先级列表
- [ ] 第一个模型成功时，日志标记为 "first model succeeded"
- [ ] 遇到 429 时，日志显示 "trying next model"
- [ ] 成功回退时，日志显示失败原因分类（429/quota/empty）
- [ ] 所有模型失败时，日志显示 "All OpenRouter models in priority list failed"
- [ ] 非可恢复错误时，日志显示 "non-recoverable error, not trying other models"
- [ ] 最终仍会 fallback 到 Gemini/Claude（如果 OpenRouter 完全失败）

## 日志位置

```bash
# Worker 服务日志
~/.claude-mem/logs/worker.log

# 搜索相关日志
grep -i "openrouter" ~/.claude-mem/logs/worker.log | tail -50
grep "429" ~/.claude-mem/logs/worker.log | tail -20
grep "fallback" ~/.claude-mem/logs/worker.log | tail -20
```

## 回滚方案

如果发现问题需要回滚：

```bash
git diff src/services/worker/OpenRouterAgent.ts
git checkout src/services/worker/OpenRouterAgent.ts
npm run build
```

## 下一步优化建议

1. **指标收集**: 统计每个模型的成功率和失败原因
2. **动态调整**: 根据历史数据自动调整模型优先级
3. **并发请求**: 对于非 429 错误，可以考虑同时请求多个模型并取最快响应
4. **配置验证**: 启动时验证配置的模型是否有效
