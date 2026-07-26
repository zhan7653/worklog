#!/usr/bin/env node
// 读完 stdin 的 prompt 后,向 stdout 打一行 codex exec --json 风格事件,
// agent_message 的 text 是 match schema(实现方案 §5.5)的 JSON 字符串。

const chunks = []
process.stdin.on('data', chunk => chunks.push(chunk))
process.stdin.on('end', () => {
  const match = {
    merges: [{ candidateId: 'cand-dup', duplicateOf: 'e-first' }],
    completions: [{ candidateId: 'cand-done', todoId: 'todo-open', confidence: 'high' }],
    overview: '今天收敛了授权边界与渲染测试，两个项目各有推进。',
  }
  process.stdout.write(`${JSON.stringify({
    type: 'item.completed',
    item: { type: 'agent_message', text: JSON.stringify(match) },
  })}\n`)
})
