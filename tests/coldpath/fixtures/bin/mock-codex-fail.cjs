#!/usr/bin/env node
// 消费掉 stdin(避免调用方写 prompt 时 EPIPE),然后以 exit 1 失败。

process.stdin.resume()
process.stdin.on('end', () => {
  console.error('mock codex failure')
  process.exit(1)
})
