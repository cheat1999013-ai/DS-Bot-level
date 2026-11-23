import '@deepseek-ai/dsh-llm'

export interface NativeTaskEvent {
  readonly planId: string
  readonly cardId?: string
  readonly event: string
  readonly from: { readonly id: string; readonly name?: string }
  readonly to: { readonly id: string; readonly name?: string }
  readonly recovery?: { readonly key: string; readonly kind: string; readonly period?: number }
}
export interface NativeTaskSource {
  readonly kind: 'taskflow'
  readonly version: 1
  readonly form: 'task'
  readonly role: 'post' | 'room'
  readonly roomId: string
  readonly taskflowEvent: NativeTaskEvent
  readonly exchangeId?: string
  readonly senderSessionId: string
  readonly senderName: string
}
// DSH exposes MessageSourceMap as an extensible interface. The task source belongs
// to this plugin; user-role is only its model-input carrier, never its identity.
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap { taskflow: NativeTaskSource }
}
export function validateTaskEvent(value: unknown): NativeTaskEvent | null
export function nativeTaskSource(roomId: string, event: NativeTaskEvent, extra?: Record<string, unknown>): NativeTaskSource
export function taskMessageOf(data: unknown): NativeTaskEvent | { planId: string; cardId?: string; event?: string } | null
export function taskIdentityOf(data: unknown): { planId: string; cardId?: string; event?: string } | null
export function isTeamMessageSource(source: unknown): boolean
export function taskflowReference(text: unknown): { planId: string; cardId?: string } | null
