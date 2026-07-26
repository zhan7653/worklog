#!/usr/bin/env node
// 退出码 0,但 agent_message 的 text 不是合法 JSON —— 命中"坏 JSON 抛错"路径。

process.stdin.resume()
process.stdin.on('end', () => {
  process.stdout.write(`${JSON.stringify({
    type: 'item.completed',
    item: { type: 'agent_message', text: '{ this is not valid json' },
  })}\n`)
})
