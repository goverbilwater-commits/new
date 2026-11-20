import {
  AlertCircle,
  Check,
  CheckCircle2,
  Copy,
  Eye,
  EyeOff,
  KeyRound,
  Loader2,
  Plus,
  RefreshCw,
  Server,
  Trash2,
  X,
} from 'lucide-react';
import { useEffect, useState, type ClipboardEvent, type FormEvent } from 'react';
import type { ConfigStatus } from '../shared/types.ts';

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  configStatus: ConfigStatus;
  pawanKeyOverride?: string;
  pawanFallbackKeyOverride?: string;
  onSavePawanKeys?: (key: string, fallbackKey: string) => void;
  onKeysUpdated?: () => void;
}

type KeyTestStatus = 'idle' | 'testing' | 'valid' | 'invalid';

interface KeyEntry {
  id: string;
  key: string;
  testStatus: KeyTestStatus;
  testMessage?: string;
}

function parseRawKeyList(raw: string): string[] {
  return raw
    .split(/[\r\n,;]+/)
    .map((k) => k.trim())
    .filter((k) => k.length > 0);
}

export function SettingsModal({
  isOpen,
  onClose,
  configStatus,
  pawanKeyOverride,
  pawanFallbackKeyOverride,
  onSavePawanKeys,
  onKeysUpdated,
}: SettingsModalProps) {
  const [keysList, setKeysList] = useState<KeyEntry[]>([]);
  const [isLoadingKeys, setIsLoadingKeys] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [showAllKeys, setShowAllKeys] = useState(true);
  const [bulkInputOpen, setBulkInputOpen] = useState(false);
  const [bulkText, setBulkText] = useState('');
  const [saveSuccessMsg, setSaveSuccessMsg] = useState<string | null>(null);
  const [saveErrorMsg, setSaveErrorMsg] = useState<string | null>(null);
  const [isTestingAll, setIsTestingAll] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  // Load keys from server whenever modal opens
  useEffect(() => {
    if (!isOpen) {
      setSaveSuccessMsg(null);
      setSaveErrorMsg(null);
      setBulkInputOpen(false);
      return;
    }

    setIsLoadingKeys(true);
    fetch('/api/config/keys')
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { keys?: string[] } | null) => {
        if (data && Array.isArray(data.keys) && data.keys.length > 0) {
          setKeysList(
            data.keys.map((k) => ({
              id: Math.random().toString(36).substring(2, 9),
              key: k,
              testStatus: 'idle',
            }))
          );
        } else {
          // If no server keys, fallback to client state if present on this device
          const localKeys = [
            ...parseRawKeyList(pawanKeyOverride || ''),
            ...parseRawKeyList(pawanFallbackKeyOverride || ''),
          ];
          if (localKeys.length > 0) {
            setKeysList(
              localKeys.map((k) => ({
                id: Math.random().toString(36).substring(2, 9),
                key: k,
                testStatus: 'idle',
              }))
            );
          } else {
            setKeysList([
              {
                id: Math.random().toString(36).substring(2, 9),
                key: '',
                testStatus: 'idle',
              },
            ]);
          }
        }
      })
      .catch((err) => {
        console.error('Failed to load server keys:', err);
        const localKeys = [
          ...parseRawKeyList(pawanKeyOverride || ''),
          ...parseRawKeyList(pawanFallbackKeyOverride || ''),
        ];
        if (localKeys.length > 0) {
          setKeysList(
            localKeys.map((k) => ({
              id: Math.random().toString(36).substring(2, 9),
              key: k,
              testStatus: 'idle',
            }))
          );
        } else {
          setKeysList([
            {
              id: Math.random().toString(36).substring(2, 9),
              key: '',
              testStatus: 'idle',
            },
          ]);
        }
      })
      .finally(() => {
        setIsLoadingKeys(false);
      });
  }, [isOpen, pawanKeyOverride, pawanFallbackKeyOverride]);

  if (!isOpen) return null;

  const handleKeyChange = (id: string, value: string) => {
    setKeysList((prev) =>
      prev.map((item) =>
        item.id === id
          ? { ...item, key: value, testStatus: 'idle', testMessage: undefined }
          : item
      )
    );
  };

  const handleAddSlot = () => {
    setKeysList((prev) => [
      ...prev,
      {
        id: Math.random().toString(36).substring(2, 9),
        key: '',
        testStatus: 'idle',
      },
    ]);
  };

  const handleRemoveSlot = (id: string) => {
    setKeysList((prev) => {
      const filtered = prev.filter((item) => item.id !== id);
      return filtered.length > 0
        ? filtered
        : [
            {
              id: Math.random().toString(36).substring(2, 9),
              key: '',
              testStatus: 'idle',
            },
          ];
    });
  };

  const handleSinglePaste = (
    id: string,
    e: ClipboardEvent<HTMLInputElement>
  ) => {
    const pasted = e.clipboardData.getData('text');
    const parsed = parseRawKeyList(pasted);
    if (parsed.length > 1) {
      e.preventDefault();
      // Replace current slot with first key, append remaining keys
      setKeysList((prev) => {
        const index = prev.findIndex((item) => item.id === id);
        if (index === -1) return prev;
        const before = prev.slice(0, index);
        const after = prev.slice(index + 1);
        const newEntries = parsed.map((k) => ({
          id: Math.random().toString(36).substring(2, 9),
          key: k,
          testStatus: 'idle' as KeyTestStatus,
        }));
        return [...before, ...newEntries, ...after];
      });
    }
  };

  const handleApplyBulkText = () => {
    const parsed = parseRawKeyList(bulkText);
    if (parsed.length === 0) return;

    setKeysList((prev) => {
      const existingKeys = new Set(
        prev.map((item) => item.key.trim()).filter(Boolean)
      );
      const additions: KeyEntry[] = [];
      for (const k of parsed) {
        if (!existingKeys.has(k)) {
          existingKeys.add(k);
          additions.push({
            id: Math.random().toString(36).substring(2, 9),
            key: k,
            testStatus: 'idle',
          });
        }
      }
      const cleanedCurrent = prev.filter((item) => item.key.trim().length > 0);
      return [...cleanedCurrent, ...additions];
    });

    setBulkText('');
    setBulkInputOpen(false);
  };

  const handleTestKey = async (id: string, checkTts = false) => {
    const target = keysList.find((k) => k.id === id);
    if (!target || !target.key.trim()) return;

    setKeysList((prev) =>
      prev.map((item) =>
        item.id === id ? { ...item, testStatus: 'testing' } : item
      )
    );

    try {
      const res = await fetch('/api/config/test-key', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: target.key.trim(), checkTts }),
      });
      const data = (await res.json()) as {
        valid?: boolean;
        message?: string;
        error?: string;
      };
      if (data.valid) {
        setKeysList((prev) =>
          prev.map((item) =>
            item.id === id
              ? {
                  ...item,
                  testStatus: 'valid',
                  testMessage: data.message || '200 OK',
                }
              : item
          )
        );
      } else {
        setKeysList((prev) =>
          prev.map((item) =>
            item.id === id
              ? {
                  ...item,
                  testStatus: 'invalid',
                  testMessage: data.error || 'Invalid key',
                }
              : item
          )
        );
      }
    } catch {
      setKeysList((prev) =>
        prev.map((item) =>
          item.id === id
            ? { ...item, testStatus: 'invalid', testMessage: 'Network error' }
            : item
        )
      );
    }
  };

  const handleTestAllKeys = async (checkTts = false) => {
    const validKeys = keysList.filter((k) => k.key.trim().length > 0);
    if (validKeys.length === 0) return;

    setIsTestingAll(true);
    await Promise.all(validKeys.map((k) => handleTestKey(k.id, checkTts)));
    setIsTestingAll(false);
  };

  const handleCopyKey = (id: string, text: string) => {
    if (!text.trim()) return;
    navigator.clipboard.writeText(text).catch(() => {});
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 1500);
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setIsSaving(true);
    setSaveSuccessMsg(null);
    setSaveErrorMsg(null);

    const cleanedKeys = Array.from(
      new Set(
        keysList
          .map((item) => item.key.trim())
          .filter((k) => k.length > 0)
      )
    );

    try {
      const res = await fetch('/api/config/keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ keys: cleanedKeys }),
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Failed to save keys to server');
      }

      const data = (await res.json()) as { count: number; keys?: string[] };
      const primary = cleanedKeys[0] || '';
      const fallback = cleanedKeys.slice(1).join(',');
      onSavePawanKeys?.(primary, fallback);
      setSaveSuccessMsg(
        `Saved ${data.count} key${data.count === 1 ? '' : 's'} permanently to server! Active across all devices.`
      );
      onKeysUpdated?.();
      setTimeout(() => {
        setSaveSuccessMsg(null);
      }, 4000);
    } catch (error) {
      setSaveErrorMsg(
        error instanceof Error ? error.message : 'Error saving keys'
      );
    } finally {
      setIsSaving(false);
    }
  };

  const validKeyCount = keysList.filter((k) => k.key.trim().length > 0).length;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-xs p-3 sm:p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="settings-modal-title"
    >
      <div className="w-full max-w-2xl max-h-[92vh] flex flex-col rounded-2xl border border-slate-800 bg-[#111827] shadow-2xl">
        {/* Modal Header */}
        <div className="flex items-center justify-between border-b border-slate-800 px-6 py-4 shrink-0">
          <div className="flex items-center gap-2.5">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-amber-500/10 text-amber-400">
              <KeyRound className="h-4 w-4" />
            </div>
            <div>
              <h2
                id="settings-modal-title"
                className="text-base font-semibold tracking-tight text-slate-100"
              >
                Pawan.Krd API Keys (Multi-Key Pool)
              </h2>
              <p className="text-xs text-slate-400">
                Synced to server & available across all PCs and devices
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1.5 text-slate-400 transition-colors hover:bg-slate-800 hover:text-slate-100 focus-visible:outline-2 focus-visible:outline-amber-500"
            aria-label="Close settings modal"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Modal Body */}
        <form onSubmit={handleSubmit} className="flex flex-col overflow-hidden flex-1">
          <div className="p-6 overflow-y-auto space-y-4 flex-1">
            {/* Server Status Banner */}
            <div className="rounded-xl border border-slate-800 bg-[#0B0F17] p-4 text-xs space-y-2.5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2 text-slate-300 font-medium">
                  <Server className="h-4 w-4 text-emerald-400 shrink-0" />
                  <span>Server-Persisted Key Pool</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="rounded-full bg-emerald-500/10 px-2.5 py-0.5 font-mono text-[11px] font-semibold text-emerald-400 border border-emerald-500/20">
                    {validKeyCount} {validKeyCount === 1 ? 'Key' : 'Keys'} Configured
                  </span>
                  {configStatus.hasGeminiKey && (
                    <span className="rounded-full bg-blue-500/10 px-2.5 py-0.5 font-mono text-[11px] font-medium text-blue-400 border border-blue-500/20">
                      Gemini Ready
                    </span>
                  )}
                </div>
              </div>
              <p className="text-slate-400 leading-relaxed">
                When you click <strong className="text-slate-200">Save to Server</strong>, your keys are stored on the server so you can access and use them from any PC, phone, or browser without re-entering them. The synthesizer spreads lines concurrently across all active keys and automatically fails over if a key hits rate limits.
              </p>
            </div>

            {/* Alert Messages */}
            {saveSuccessMsg && (
              <div className="flex items-center gap-2 rounded-lg border border-emerald-500/30 bg-emerald-950/40 p-3 text-xs text-emerald-300 animate-in fade-in">
                <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-400" />
                <span>{saveSuccessMsg}</span>
              </div>
            )}

            {saveErrorMsg && (
              <div className="flex items-center gap-2 rounded-lg border border-red-500/30 bg-red-950/40 p-3 text-xs text-red-300 animate-in fade-in">
                <AlertCircle className="h-4 w-4 shrink-0 text-red-400" />
                <span>{saveErrorMsg}</span>
              </div>
            )}

            {/* Controls Bar */}
            <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={handleAddSlot}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-1.5 text-xs font-semibold text-amber-400 transition-colors hover:bg-amber-500/20"
                >
                  <Plus className="h-3.5 w-3.5" />
                  Add Key Slot
                </button>
                <button
                  type="button"
                  onClick={() => setBulkInputOpen((prev) => !prev)}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-800/60 px-3 py-1.5 text-xs font-medium text-slate-300 transition-colors hover:bg-slate-700"
                >
                  {bulkInputOpen ? 'Hide Bulk Paste' : 'Bulk Paste 10+ Keys'}
                </button>
              </div>

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => void handleTestAllKeys(false)}
                  disabled={isTestingAll || validKeyCount === 0}
                  title="Free auth check via /v1/models (0 credits)"
                  className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-800/60 px-3 py-1.5 text-xs font-medium text-slate-300 transition-colors hover:bg-slate-700 disabled:opacity-50"
                >
                  <RefreshCw className={`h-3.5 w-3.5 ${isTestingAll ? 'animate-spin text-amber-400' : ''}`} />
                  Test Auth
                </button>
                <button
                  type="button"
                  onClick={() => void handleTestAllKeys(true)}
                  disabled={isTestingAll || validKeyCount === 0}
                  title="Checks real TTS synthesis & credit balance (uses 1-2 credits per key)"
                  className="inline-flex items-center gap-1.5 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-1.5 text-xs font-medium text-amber-300 transition-colors hover:bg-amber-500/20 disabled:opacity-50"
                >
                  Check Credits
                </button>
                <button
                  type="button"
                  onClick={() => setShowAllKeys((prev) => !prev)}
                  className="inline-flex items-center gap-1 rounded-lg border border-slate-700 bg-slate-800/60 px-2.5 py-1.5 text-xs text-slate-400 hover:text-slate-200"
                  title={showAllKeys ? 'Mask keys' : 'Reveal keys'}
                >
                  {showAllKeys ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                  <span>{showAllKeys ? 'Mask' : 'Reveal'}</span>
                </button>
              </div>
            </div>

            {/* Bulk Paste Drawer */}
            {bulkInputOpen && (
              <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-4 space-y-2.5 animate-in fade-in">
                <div className="flex items-center justify-between">
                  <label htmlFor="bulk-key-input" className="text-xs font-semibold text-amber-300">
                    Paste Multiple Pawan.Krd Keys (comma, space, or newline separated)
                  </label>
                  <span className="text-[11px] text-slate-400">
                    {parseRawKeyList(bulkText).length} keys detected
                  </span>
                </div>
                <textarea
                  id="bulk-key-input"
                  rows={4}
                  value={bulkText}
                  onChange={(e) => setBulkText(e.target.value)}
                  placeholder={`pk-ocbPXKUIutCRQmdxCFHsytlRkNKmntgqUPBJVFwBUBvhnepb\npk-anotherkey12345...\npk-thirdkey67890...`}
                  className="w-full rounded-lg border border-slate-700 bg-[#0B0F17] p-3 text-xs text-slate-100 placeholder-slate-500 font-mono focus:border-amber-500 focus:outline-none"
                />
                <div className="flex justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      setBulkText('');
                      setBulkInputOpen(false);
                    }}
                    className="rounded-lg px-3 py-1.5 text-xs text-slate-400 hover:text-slate-200"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={handleApplyBulkText}
                    disabled={parseRawKeyList(bulkText).length === 0}
                    className="rounded-lg bg-amber-500 px-3 py-1.5 text-xs font-semibold text-slate-950 hover:bg-amber-400 disabled:opacity-50"
                  >
                    Add {parseRawKeyList(bulkText).length > 0 ? parseRawKeyList(bulkText).length : ''} Keys to List
                  </button>
                </div>
              </div>
            )}

            {/* Keys List */}
            <div className="space-y-2.5">
              {isLoadingKeys ? (
                <div className="flex items-center justify-center py-10 text-slate-400 gap-2">
                  <Loader2 className="h-5 w-5 animate-spin text-amber-400" />
                  <span className="text-xs">Loading keys from server...</span>
                </div>
              ) : (
                keysList.map((entry, index) => {
                  const isPrimary = index === 0;
                  return (
                    <div
                      key={entry.id}
                      className="group flex flex-col sm:flex-row sm:items-center gap-2 rounded-xl border border-slate-800 bg-[#0B0F17] p-2.5 transition-colors hover:border-slate-700"
                    >
                      {/* Badge */}
                      <div className="flex items-center gap-2 shrink-0">
                        <span
                          className={`w-14 text-center rounded-md px-1.5 py-1 font-mono text-[10px] font-semibold uppercase tracking-wider ${
                            isPrimary
                              ? 'bg-amber-500/10 text-amber-400 border border-amber-500/20'
                              : 'bg-slate-800 text-slate-400 border border-slate-700'
                          }`}
                        >
                          {isPrimary ? 'Primary' : `#${index + 1}`}
                        </span>
                      </div>

                      {/* Input */}
                      <div className="relative flex-1">
                        <input
                          type={showAllKeys ? 'text' : 'password'}
                          value={entry.key}
                          onChange={(e) => handleKeyChange(entry.id, e.target.value)}
                          onPaste={(e) => handleSinglePaste(entry.id, e)}
                          placeholder={isPrimary ? 'pk-... (Primary Key)' : `pk-... (Backup #${index + 1})`}
                          autoComplete="off"
                          className="w-full rounded-lg border border-slate-700/80 bg-slate-900/60 py-2 pl-3 pr-8 text-xs text-slate-100 placeholder-slate-500 font-mono focus:border-amber-500 focus:outline-none"
                        />
                        {entry.key.trim() && (
                          <button
                            type="button"
                            onClick={() => handleCopyKey(entry.id, entry.key)}
                            title="Copy key to clipboard"
                            className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-200"
                          >
                            {copiedId === entry.id ? (
                              <Check className="h-3.5 w-3.5 text-emerald-400" />
                            ) : (
                              <Copy className="h-3.5 w-3.5" />
                            )}
                          </button>
                        )}
                      </div>

                      {/* Test Button & Status */}
                      <div className="flex items-center gap-2 shrink-0 self-end sm:self-center">
                        {entry.testStatus === 'valid' && (
                          <span className="flex items-center gap-1 text-[11px] font-medium text-emerald-400">
                            <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
                            <span>{entry.testMessage || 'OK'}</span>
                          </span>
                        )}
                        {entry.testStatus === 'invalid' && (
                          <span className="flex items-center gap-1 text-[11px] font-medium text-red-400" title={entry.testMessage}>
                            <AlertCircle className="h-3.5 w-3.5 shrink-0" />
                            <span>{entry.testMessage || 'Failed'}</span>
                          </span>
                        )}
                        {entry.testStatus === 'testing' && (
                          <span className="flex items-center gap-1 text-[11px] text-amber-400">
                            <Loader2 className="h-3.5 w-3.5 animate-spin shrink-0" />
                            <span>Testing</span>
                          </span>
                        )}

                        <button
                          type="button"
                          onClick={() => void handleTestKey(entry.id, true)}
                          disabled={!entry.key.trim() || entry.testStatus === 'testing'}
                          title="Tests auth + TTS credit balance"
                          className="rounded-lg border border-slate-700 bg-slate-800/80 px-2.5 py-1.5 text-[11px] font-medium text-slate-300 transition-colors hover:bg-slate-700 disabled:opacity-40"
                        >
                          Test
                        </button>

                        <button
                          type="button"
                          onClick={() => handleRemoveSlot(entry.id)}
                          title="Remove key"
                          className="rounded-lg p-1.5 text-slate-500 transition-colors hover:bg-red-950/50 hover:text-red-400"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </div>

          {/* Modal Footer */}
          <div className="flex items-center justify-between border-t border-slate-800 bg-[#0B0F17]/80 px-6 py-4 shrink-0">
            <div className="text-xs text-slate-400">
              <span className="font-semibold text-slate-200">{validKeyCount}</span> valid{' '}
              {validKeyCount === 1 ? 'key' : 'keys'} in rotation
            </div>

            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={onClose}
                className="rounded-xl border border-slate-700 px-4 py-2 text-xs font-medium text-slate-300 transition-colors hover:bg-slate-800"
              >
                Close
              </button>
              <button
                type="submit"
                disabled={isSaving}
                className="inline-flex items-center gap-2 rounded-xl bg-amber-500 px-5 py-2 text-xs font-semibold text-slate-950 transition-colors hover:bg-amber-400 disabled:opacity-50"
              >
                {isSaving ? (
                  <>
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    <span>Saving to Server...</span>
                  </>
                ) : (
                  <>
                    <Server className="h-3.5 w-3.5" />
                    <span>Save to Server</span>
                  </>
                )}
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}
