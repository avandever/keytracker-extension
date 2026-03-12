import { useEffect, useState, useCallback } from "react";
import {
  Box,
  Typography,
  Button,
  Chip,
  Divider,
  CircularProgress,
  Stack,
  Alert,
  IconButton,
  Tooltip,
  Switch,
  FormControlLabel,
  Collapse,
} from "@mui/material";
import DownloadIcon from "@mui/icons-material/Download";
import DeleteSweepIcon from "@mui/icons-material/DeleteSweep";
import RefreshIcon from "@mui/icons-material/Refresh";
import SettingsIcon from "@mui/icons-material/Settings";
import FiberManualRecordIcon from "@mui/icons-material/FiberManualRecord";
import CloudUploadIcon from "@mui/icons-material/CloudUpload";
import CheckCircleIcon from "@mui/icons-material/CheckCircle";
import type { BackgroundState, GameSession, Settings } from "../types";

function formatDuration(startMs: number, endMs?: number): string {
  const ms = (endMs ?? Date.now()) - startMs;
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

function downloadJson(data: unknown, filename: string): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

const TRACKER_URL = "https://tracker.ancientbearrepublic.com";

function SessionCard({
  session,
  isActive,
  submitting,
  onSubmit,
}: {
  session: GameSession;
  isActive: boolean;
  submitting: boolean;
  onSubmit: (sessionId: string) => void;
}) {
  const eventCount = session.events.length;
  const snapCount = session.gamestateSnapshots.length;
  const label = session.crucibleGameId
    ? session.crucibleGameId.slice(0, 8)
    : session.sessionId.slice(3, 11);
  const p1 = session.player1 ?? "?";
  const p2 = session.player2 ?? "?";

  function handleDownload() {
    const filename = `kt_${label}_${new Date(session.startTime).toISOString().slice(0, 10)}.json`;
    downloadJson(session, filename);
  }

  const gameUrl = session.submittedGameId
    ? `${TRACKER_URL}/mui/games/${session.submittedGameId}`
    : null;

  return (
    <Box
      sx={{
        border: "1px solid",
        borderColor: isActive ? "primary.main" : "divider",
        borderRadius: 1,
        p: 1.5,
        mb: 1,
        bgcolor: isActive ? "rgba(25,118,210,0.08)" : "background.paper",
      }}
    >
      <Stack direction="row" alignItems="center" justifyContent="space-between">
        <Stack direction="row" alignItems="center" spacing={1}>
          {isActive && (
            <FiberManualRecordIcon
              sx={{ color: "primary.main", fontSize: 12, animation: "pulse 1.5s ease-in-out infinite" }}
            />
          )}
          <Typography variant="body2" fontFamily="monospace">
            {label}
          </Typography>
          {session.winner && (
            <Chip
              label={`🏆 ${session.winner}`}
              size="small"
              color="success"
              variant="outlined"
            />
          )}
        </Stack>
        <Stack direction="row" alignItems="center" spacing={0.5}>
          {/* Submit / status button (completed sessions only) */}
          {!isActive && (
            <>
              {session.submittedAt ? (
                <Tooltip title={gameUrl ? "View game on tracker" : "Submitted"}>
                  <Chip
                    icon={<CheckCircleIcon />}
                    label={gameUrl ? `#${session.submittedGameId}` : "Submitted"}
                    size="small"
                    color="success"
                    variant="outlined"
                    component={gameUrl ? "a" : "div"}
                    href={gameUrl ?? undefined}
                    target="_blank"
                    rel="noreferrer"
                    clickable={!!gameUrl}
                    sx={{ cursor: gameUrl ? "pointer" : "default" }}
                  />
                </Tooltip>
              ) : submitting ? (
                <CircularProgress size={16} />
              ) : (
                <Tooltip title="Submit to tracker">
                  <IconButton
                    size="small"
                    color="primary"
                    onClick={() => onSubmit(session.sessionId)}
                  >
                    <CloudUploadIcon fontSize="small" />
                  </IconButton>
                </Tooltip>
              )}
            </>
          )}
          <Tooltip title="Download session JSON">
            <IconButton size="small" onClick={handleDownload}>
              <DownloadIcon fontSize="small" />
            </IconButton>
          </Tooltip>
        </Stack>
      </Stack>

      <Stack direction="row" spacing={1} mt={0.5} flexWrap="wrap">
        <Chip label={`${p1} vs ${p2}`} size="small" variant="outlined" />
        {session.player1DeckName && (
          <Chip label={session.player1DeckName} size="small" variant="outlined" color="primary" />
        )}
        {session.player2DeckName && (
          <Chip label={session.player2DeckName} size="small" variant="outlined" />
        )}
        <Chip
          label={`${snapCount} snaps`}
          size="small"
          variant="outlined"
        />
        <Chip
          label={formatDuration(session.startTime, session.endTime)}
          size="small"
          variant="outlined"
        />
      </Stack>

      {session.submitError && (
        <Typography variant="caption" color="error" display="block" mt={0.5}>
          Error: {session.submitError}
        </Typography>
      )}
    </Box>
  );
}

export default function App() {
  const [state, setState] = useState<BackgroundState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState<Set<string>>(new Set());
  const [showSettings, setShowSettings] = useState(false);
  const [draftAutoSubmit, setDraftAutoSubmit] = useState(false);
  const [draftDebugMode, setDraftDebugMode] = useState(false);

  const refresh = useCallback(() => {
    setLoading(true);
    chrome.runtime
      .sendMessage({ type: "GET_STATE" })
      .then((resp: BackgroundState) => {
        setState(resp);
        setError(null);
      })
      .catch(() => setError("Could not reach background worker."))
      .finally(() => setLoading(false));
  }, []);

  // Auto-refresh every 2 seconds while in-game
  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 2000);
    return () => clearInterval(id);
  }, [refresh]);

  // Keep settings draft in sync with loaded state
  useEffect(() => {
    if (state?.settings) {
      setDraftAutoSubmit(state.settings.autoSubmit);
      setDraftDebugMode(state.settings.debugMode ?? false);
    }
  }, [state?.settings]);

  function handleClearCompleted() {
    chrome.runtime.sendMessage({ type: "CLEAR_COMPLETED" }).then(refresh);
  }

  function handleDownloadAll() {
    chrome.runtime.sendMessage({ type: "DOWNLOAD_ALL" }).then((resp) => {
      const sessions = (resp as { sessions: GameSession[] }).sessions;
      downloadJson(sessions, `kt_all_sessions_${Date.now()}.json`);
    });
  }

  function handleSubmit(sessionId: string) {
    setSubmitting((prev) => new Set(prev).add(sessionId));
    chrome.runtime
      .sendMessage({ type: "SUBMIT_SESSION", sessionId })
      .then(() => {
        setSubmitting((prev) => {
          const next = new Set(prev);
          next.delete(sessionId);
          return next;
        });
        refresh();
      })
      .catch(() => {
        setSubmitting((prev) => {
          const next = new Set(prev);
          next.delete(sessionId);
          return next;
        });
        refresh();
      });
  }

  function handleDownloadDebugLog() {
    chrome.runtime.sendMessage({ type: "GET_DEBUG_LOG" }).then((resp) => {
      const entries = (resp as { entries: unknown[] }).entries;
      downloadJson(entries, `kt_debug_log_${Date.now()}.json`);
    });
  }

  function handleClearDebugLog() {
    chrome.runtime.sendMessage({ type: "CLEAR_DEBUG_LOG" });
  }

  function handleSaveSettings() {
    const newSettings: Settings = {
      autoSubmit: draftAutoSubmit,
      debugMode: draftDebugMode,
    };
    chrome.runtime
      .sendMessage({ type: "SAVE_SETTINGS", settings: newSettings })
      .then(refresh);
    setShowSettings(false);
  }

  const current = state?.currentSession ?? null;
  const completed = state?.completedSessions ?? [];

  return (
    <Box sx={{ p: 1.5, minWidth: 360, maxWidth: 480 }}>
      {/* Header */}
      <Stack direction="row" alignItems="center" justifyContent="space-between" mb={1}>
        <Stack direction="row" alignItems="center" spacing={1}>
          <Typography variant="h6" sx={{ fontSize: 15, fontWeight: 700 }}>
            KeyTracker
          </Typography>
          <Chip label="v1.0" size="small" color="primary" variant="outlined" />
        </Stack>
        <Stack direction="row" spacing={0.5}>
          <Tooltip title="Settings">
            <IconButton size="small" onClick={() => setShowSettings((v) => !v)}>
              <SettingsIcon fontSize="small" />
            </IconButton>
          </Tooltip>
          <Tooltip title="Refresh">
            <IconButton size="small" onClick={refresh}>
              <RefreshIcon fontSize="small" />
            </IconButton>
          </Tooltip>
        </Stack>
      </Stack>

      {/* Settings panel */}
      <Collapse in={showSettings}>
        <Box
          sx={{
            border: "1px solid",
            borderColor: "divider",
            borderRadius: 1,
            p: 1.5,
            mb: 1,
            bgcolor: "action.hover",
          }}
        >
          <Typography variant="overline" display="block" mb={1}>
            Settings
          </Typography>
          <FormControlLabel
            control={
              <Switch
                size="small"
                checked={draftAutoSubmit}
                onChange={(e) => setDraftAutoSubmit(e.target.checked)}
              />
            }
            label={<Typography variant="body2">Auto-submit on game end</Typography>}
          />
          <FormControlLabel
            control={
              <Switch
                size="small"
                checked={draftDebugMode}
                onChange={(e) => setDraftDebugMode(e.target.checked)}
              />
            }
            label={<Typography variant="body2">Debug event logging</Typography>}
          />
          <Stack direction="row" spacing={1} justifyContent="flex-end" mt={0.5}>
            {state?.settings?.debugMode && (
              <>
                <Button size="small" variant="outlined" onClick={handleClearDebugLog}>
                  Clear log
                </Button>
                <Button size="small" variant="outlined" startIcon={<DownloadIcon />} onClick={handleDownloadDebugLog}>
                  Debug log
                </Button>
              </>
            )}
            <Button size="small" variant="contained" onClick={handleSaveSettings}>
              Save
            </Button>
          </Stack>
        </Box>
      </Collapse>

      {error && (
        <Alert severity="error" sx={{ mb: 1 }}>
          {error}
        </Alert>
      )}

      {loading && !state ? (
        <Box display="flex" justifyContent="center" py={3}>
          <CircularProgress size={24} />
        </Box>
      ) : (
        <>
          {/* Active session */}
          {current ? (
            <>
              <Typography variant="overline" color="primary">
                Active Game
              </Typography>
              <SessionCard
                session={current}
                isActive
                submitting={false}
                onSubmit={handleSubmit}
              />
            </>
          ) : (
            <Alert severity="info" sx={{ mb: 1, py: 0.5 }}>
              Not in a game. Navigate to thecrucible.online to start capturing.
            </Alert>
          )}

          {/* Completed sessions */}
          {completed.length > 0 && (
            <>
              <Divider sx={{ my: 1 }} />
              <Stack direction="row" alignItems="center" justifyContent="space-between" mb={0.5}>
                <Typography variant="overline">
                  Completed ({completed.length})
                </Typography>
                <Stack direction="row" spacing={0.5}>
                  <Tooltip title="Download all sessions as JSON">
                    <Button
                      size="small"
                      startIcon={<DownloadIcon />}
                      onClick={handleDownloadAll}
                      variant="outlined"
                    >
                      All
                    </Button>
                  </Tooltip>
                  <Tooltip title="Clear completed sessions from memory">
                    <IconButton size="small" onClick={handleClearCompleted}>
                      <DeleteSweepIcon fontSize="small" />
                    </IconButton>
                  </Tooltip>
                </Stack>
              </Stack>

              {[...completed].reverse().map((s) => (
                <SessionCard
                  key={s.sessionId}
                  session={s}
                  isActive={false}
                  submitting={submitting.has(s.sessionId)}
                  onSubmit={handleSubmit}
                />
              ))}
            </>
          )}

          {!current && completed.length === 0 && (
            <Typography variant="caption" color="text.secondary" display="block" mt={1}>
              Play a game on thecrucible.online — session data will appear here.
            </Typography>
          )}
        </>
      )}

      <Divider sx={{ mt: 1.5, mb: 1 }} />
      <Typography variant="caption" color="text.disabled" display="block" textAlign="center">
        Submits to tracker.ancientbearrepublic.com
      </Typography>
    </Box>
  );
}
