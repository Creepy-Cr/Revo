import { Fragment, memo, useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Send, Sparkles, Loader2, Lock } from 'lucide-react';
import {
  getListAgentChatMessagesQueryKey,
  useAskTreasuryAgent,
  useListAgentChatMessages,
} from '@workspace/api-client-react';
import { apiErrorMessage } from '@/lib/api-error';
import { cn } from '@/lib/utils';
import { useAuthContext } from './auth-context';
import { trackEvent } from '@/lib/analytics';

export const AGENT_NAME = 'Arcus';

interface ChatMessage {
  id: string;
  role: 'user' | 'agent' | 'error';
  text: string;
  at: string;
}

const SUGGESTIONS = [
  'Why is the risk score where it is?',
  'Explain the latest ETH signal',
  'What did the last rebalance change?',
];

function AgentChatImpl() {
  const { session } = useAuthContext();
  const askAgent = useAskTreasuryAgent();
  const queryClient = useQueryClient();
  const history = useListAgentChatMessages({
    query: {
      queryKey: getListAgentChatMessagesQueryKey(),
      enabled: !!session,
      retry: false,
    },
  });
  const [localMessages, setLocalMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState('');
  // Real, client-measured timings for the thinking loader and the
  // "Thought for Xs" caption - never synthetic.
  const [lastDuration, setLastDuration] = useState<number | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const messages = useMemo<ChatMessage[]>(() => {
    const server: ChatMessage[] = (history.data ?? []).map((m) => ({
      id: m.id,
      role: m.role === 'agent' ? 'agent' : 'user',
      text: m.content,
      at: m.createdAt,
    }));
    const recentServerTexts = new Set(server.slice(-6).map((m) => `${m.role}:${m.text}`));
    const local = localMessages.filter(
      (m) => m.role !== 'user' || !recentServerTexts.has(`user:${m.text}`),
    );
    return [...server, ...local];
  }, [history.data, localMessages]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages.length, askAgent.isPending]);

  const submit = (question: string) => {
    const trimmed = question.trim();
    if (!session || trimmed.length < 3 || askAgent.isPending) return;
    const source = SUGGESTIONS.includes(trimmed) ? 'suggestion' : 'typed';
    trackEvent('arcus_question_submitted', { source });
    setDraft('');
    setLocalMessages((prev) => [
      ...prev,
      { id: `q-${Date.now()}`, role: 'user', text: trimmed, at: new Date().toISOString() },
    ]);
    askAgent.mutate(
      { data: { question: trimmed } },
      {
        onSuccess: async () => {
          trackEvent('arcus_answer_received', { source });
          await queryClient.invalidateQueries({ queryKey: getListAgentChatMessagesQueryKey() });
          setLocalMessages([]);
        },
        onError: (error) => {
          setLocalMessages((prev) => [
            ...prev,
            {
              id: `e-${Date.now()}`,
              role: 'error',
              text: apiErrorMessage(error, `${AGENT_NAME} could not answer right now. No action was taken.`),
              at: new Date().toISOString(),
            },
          ]);
        },
      },
    );
  };

  return (
    <div className="flex flex-col h-full">
      {/* Crown Jewel Header */}
      <div className="flex items-start justify-between mb-6 shrink-0 pt-2 px-2">
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-full bg-primary/10 border border-primary/30 flex items-center justify-center shadow-[0_0_15px_rgba(252,59,0,0.2)]">
              <Sparkles className="w-4 h-4 text-primary" />
            </div>
            <h3 className="text-xl font-display font-semibold text-white tracking-tight">
              {AGENT_NAME} AI
            </h3>
          </div>
          <span className="text-[11px] font-mono uppercase tracking-[0.15em] text-muted-foreground ml-11">
            Autonomous Agent
          </span>
        </div>
        <div className="flex items-center gap-2">
          <span className="flex h-1.5 w-1.5 relative">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75"></span>
            <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-green-500"></span>
          </span>
          <span className="font-mono text-xs font-medium uppercase tracking-[0.14em] text-white/70">Online</span>
        </div>
      </div>

      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto rounded-[24px] bg-[#0c0c0c] border border-white/5 p-5 flex flex-col gap-4 shadow-[inset_0_4px_24px_rgba(0,0,0,0.4)] custom-scrollbar"
        data-testid="agent-chat-messages"
      >
        {messages.length === 0 && (
          <div className="flex flex-col gap-5 m-auto items-center text-center px-4 py-8">
            <div className="w-16 h-16 rounded-full bg-gradient-to-br from-primary/20 to-transparent border border-primary/20 flex items-center justify-center mb-2 shadow-[0_0_30px_rgba(252,59,0,0.1)]">
              <Sparkles className="w-7 h-7 text-primary" />
            </div>
            <p className="text-sm text-white/70 leading-relaxed max-w-sm">
              I am <span className="text-white font-semibold">{AGENT_NAME}</span>, the treasury
              agent. Ask me why I proposed, scored, or executed anything. I answer only from the
              live testnet treasury state.
            </p>
            {session ? (
              <div className="flex flex-col gap-2 w-full mt-4">
                {SUGGESTIONS.map((s, i) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => submit(s)}
                    className="text-xs font-mono font-medium tracking-[0.02em] border border-white/10 bg-white/[0.02] rounded-none px-4 py-3 text-white/70 hover:border-primary/50 hover:bg-primary/5 hover:text-white transition-all text-left relative overflow-hidden group"
                    data-testid={`agent-suggestion-${i}`}
                  >
                    <span className="absolute left-0 top-0 bottom-0 w-1 bg-white/10 group-hover:bg-primary transition-colors" />
                    <span className="pl-2">{s}</span>
                  </button>
                ))}
              </div>
            ) : (
              <div className="mt-4 flex flex-col items-center gap-3 bg-white/5 border border-white/10 rounded-2xl p-5 w-full">
                 <div className="w-10 h-10 rounded-full bg-white/5 flex items-center justify-center">
                    <Lock className="w-4 h-4 text-muted-foreground" />
                 </div>
                 <p className="text-xs text-muted-foreground text-center" data-testid="text-chat-signin">
                   Sign in with an operator wallet to join the conversation.
                 </p>
              </div>
            )}
          </div>
        )}

        {messages.map((msg, idx) => (
          <Fragment key={msg.id}>
            {msg.role === 'agent' &&
              idx === messages.length - 1 &&
              lastDuration !== null &&
              !askAgent.isPending && (
                <div className="self-start flex items-center gap-1.5 font-mono text-[11px] uppercase tracking-[0.12em] text-white/40 pl-1 -mb-2">
                  <Sparkles className="w-3 h-3 text-primary/60" />
                  Thought for {lastDuration.toFixed(1)}s
                </div>
              )}
          <div
            className={cn(
              'msg-enter max-w-[85%] px-4 py-3 rounded-2xl text-sm leading-relaxed whitespace-pre-wrap',
              msg.role === 'user'
                ? 'self-end bg-white/10 text-white rounded-br-sm border border-white/5'
                : msg.role === 'agent'
                  ? 'self-start bg-primary/10 border border-primary/20 text-white/90 rounded-bl-sm shadow-[0_4px_20px_rgba(252,59,0,0.05)]'
                  : 'self-start bg-red-500/10 border border-red-500/30 text-red-300 rounded-bl-sm',
            )}
            data-testid={`agent-chat-message-${msg.role}`}
          >
            {msg.role !== 'user' && (
              <div
                className={cn(
                  'text-[10px] uppercase font-bold tracking-widest mb-1.5 flex items-center gap-1.5',
                  msg.role === 'agent' ? 'text-primary' : 'text-red-400',
                )}
              >
                {msg.role === 'agent' && <Sparkles className="w-3 h-3" />}
                {msg.role === 'agent' ? AGENT_NAME : 'ERROR'}
              </div>
            )}
            {msg.text}
          </div>
          </Fragment>
        ))}

        {askAgent.isPending && (
          <div
            className="self-start flex items-center gap-3 px-1 py-2 text-primary"
            data-testid="agent-chat-thinking"
          >
            <span className="pixel-loader" aria-hidden="true">
              {Array.from({ length: 9 }).map((_, i) => (
                <span key={i} />
              ))}
            </span>
            <span className="font-mono text-xs font-medium uppercase tracking-[0.14em] text-white/60">
              Reading treasury state
            </span>
            <ThinkingTimer onStop={setLastDuration} />
          </div>
        )}
      </div>

      <form
        className="flex gap-2 mt-4 shrink-0 px-1"
        onSubmit={(e) => {
          e.preventDefault();
          submit(draft);
        }}
      >
        <div className="flex-1 relative group">
          <input
            type="text"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={session ? `Ask ${AGENT_NAME}...` : 'Sign in to ask Arcus'}
            maxLength={600}
            className="w-full bg-[#141414] border border-white/10 rounded-2xl py-3.5 pl-4 pr-4 text-sm text-white placeholder:text-muted-foreground focus:outline-none focus:border-primary/50 focus:bg-[#1a1a1a] focus:ring-1 focus:ring-primary/50 transition-all shadow-inner disabled:opacity-60 leading-relaxed"
            disabled={!session || askAgent.isPending}
            data-testid="input-agent-question"
          />
        </div>
        <button
          type="submit"
          disabled={!session || askAgent.isPending || draft.trim().length < 3}
          className="shrink-0 px-4 rounded-2xl bg-primary text-white text-sm font-medium hover:bg-primary/90 disabled:opacity-40 disabled:hover:bg-primary transition-all flex items-center justify-center shadow-[0_0_15px_rgba(252,59,0,0.3)] disabled:shadow-none"
          data-testid="button-ask-agent"
        >
          {askAgent.isPending ? (
            <Loader2 className="w-5 h-5 animate-spin" />
          ) : (
            <Send className="w-5 h-5" />
          )}
        </button>
      </form>
    </div>
  );
}
/**
 * Isolated thinking clock: the 100ms tick re-renders only this tiny span,
 * not the whole chat tree. Reports the real total duration on unmount.
 */
function ThinkingTimer({ onStop }: { onStop: (seconds: number) => void }) {
  const [elapsed, setElapsed] = useState(0);
  const onStopRef = useRef(onStop);
  onStopRef.current = onStop;

  useEffect(() => {
    const start = performance.now();
    const timer = window.setInterval(() => {
      setElapsed((performance.now() - start) / 1000);
    }, 100);
    return () => {
      window.clearInterval(timer);
      onStopRef.current((performance.now() - start) / 1000);
    };
  }, []);

  return <span className="font-mono text-xs text-primary/80 tabular-nums">{elapsed.toFixed(1)}s</span>;
}

// Memoized: AgentChat sits inside ConsoleShell, which re-renders on every
// dashboard poll (1-5s). Its own query/context subscriptions still update it.
export const AgentChat = memo(AgentChatImpl);
