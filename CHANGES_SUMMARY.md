# 任务持久化恢复功能 - 修改总结

## 核心改进

将消息队列从 **claim-and-delete** 模式改为 **两阶段提交** 模式，确保 Worker 重启后任务可以继续处理。

### 修改的文件

| 文件 | 修改内容 |
|------|----------|
| `src/services/sqlite/PendingMessageStore.ts` | - 修改 `claimAndDelete()` 为两阶段提交模式<br>- 添加 `complete()` 方法<br>- 添加指数退避逻辑<br>- 更新注释 |
| `src/services/queue/SessionQueueProcessor.ts` | - 跟踪当前处理的消息 ID<br>- 在下次迭代或迭代器关闭时调用 `complete()`<br>- 添加 try/finally 确保消息完成 |
| `src/services/worker-service.ts` | - Worker 启动时立即重置所有 `processing` 消息（无时间阈值） |
| `src/services/sqlite/migrations/runner.ts` | - 添加 migration 21: `last_attempted_at_epoch` 字段 |
| `src/services/worker/agents/SessionCleanupHelper.ts` | - 更新注释反映新模式 |
| `src/services/worker/agents/ResponseProcessor.ts` | - 更新注释反映新模式 |

## 工作流程

### 修改前 (claim-and-delete)
```
pending → claim → [删除] → 处理 → 完成
                  ↑ 崩溃时丢失！
```

### 修改后 (two-phase commit)
```
pending → claim → processing → complete → [删除]
                           ↓ 崩溃时保留
                    重启后 reset → pending → 重新处理
```

## 关键机制

1. **消息认领时**：更新状态为 `processing`，增加 retry_count，记录 started_processing_at_epoch

2. **消息完成时**：调用 `complete()` 从数据库删除

3. **Worker 启动时**：
   - 首先重置所有 `processing` 消息为 `pending`（无时间阈值）
   - 这确保之前崩溃时正在处理的消息会被恢复

4. **指数退避**：
   - 失败重试间隔：1s, 2s, 4s, 8s, 16s, max 60s
   - 避免频繁重试造成资源浪费

## 重启 Worker 后的行为

1. 运行数据库迁移（如果需要）
2. 重置所有 `processing` 消息为 `pending`
3. 标记超过 24 小时的消息为 `failed`
4. 自动恢复待处理的队列
5. 日志输出：
   ```
   [SYSTEM] Recovered X messages from previous Worker session (will resume processing)
   ```

## 重启命令

```bash
npm run build-and-sync
```

## 验证方法

1. 检查数据库状态：
   ```bash
   sqlite3 ~/.claude-mem/claude-mem.db "SELECT status, COUNT(*) FROM pending_messages GROUP BY status;"
   ```

2. 查看 Worker 日志确认恢复：
   ```bash
   npm run worker:logs
   ```
   查找：
   - `Recovered X messages from previous Worker session`
   - `Marked X orphaned messages as failed`

3. 测试恢复功能：
   - 发送消息到队列
   - 在消息处理时强制杀死 Worker (`kill -9 <pid>`)
   - 重启 Worker
   - 验证消息被重新处理（查看日志）
