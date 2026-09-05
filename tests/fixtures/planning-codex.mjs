#!/usr/bin/env node
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

const record = join(process.env.CODEX_HOME, 'calls.jsonl')
const countPath = join(process.env.CODEX_HOME, 'thread-count')
const send = (value) => process.stdout.write(JSON.stringify(value) + '\n')
let turnCount = 0
let active
createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line)
  const params = message.params ?? {}
  appendFileSync(record, JSON.stringify(message) + '\n')
  if (message.method === 'initialized') return
  if (message.method === 'thread/start') {
    const count = existsSync(countPath) ? Number(readFileSync(countPath, 'utf8')) + 1 : 1
    writeFileSync(countPath, String(count))
    send({ id: message.id, result: { thread: { id: `thread-${count}` } } })
  } else if (message.method === 'turn/start') {
    const turnId = `turn-${++turnCount}`
    const threadId = params.threadId
    active = { threadId, turnId }
    const emit = (method, value) => send({ method, params: { threadId, turnId, ...value } })
    const instructions = params.input[0].text
    // Exercise events arriving before the RPC response.
    emit('item/started', { item: { id: 'command', type: 'commandExecution', commandActions: [{ path: 'Feature.swift' }] } })
    send({ id: message.id, result: { turn: { id: turnId } } })
    if (instructions.includes('[[disconnect]]')) { process.exit(1); return }
    if (instructions.includes('[[slow]]')) return
    const payload = { summary: '기능 설계', markdown: '# 목표\n\n' + '요구사항과 기존 구조를 확인해 기능 및 검증 전략을 설계합니다.\n'.repeat(5), openQuestions: [], changeSummary: '검증 기준을 정리했습니다.' }
    const text = instructions.includes('[[bad-json]]') ? 'not json' : JSON.stringify(payload)
    const middle = Math.floor(text.length / 2)
    emit('item/agentMessage/delta', { itemId: 'answer', delta: text.slice(0, middle) })
    setTimeout(() => {
      if (instructions.includes('[[empty]]')) { emit('turn/completed', { turn: { id: turnId, status: 'completed', items: [] } }); return }
      emit('item/agentMessage/delta', { itemId: 'answer', delta: text.slice(middle) })
      emit('item/completed', { item: { id: 'answer', type: 'agentMessage', phase: 'final_answer', text } })
      emit('turn/completed', { turn: { id: turnId, status: 'completed', items: [] } })
    }, 20)
  } else if (message.method === 'turn/interrupt') {
    send({ id: message.id, result: {} })
    send({ method: 'turn/completed', params: { ...active, turn: { id: active.turnId, status: 'interrupted' } } })
  } else send({ id: message.id, result: {} })
})
