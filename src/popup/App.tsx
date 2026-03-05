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
} from "@mui/material";
import DownloadIcon from "@mui/icons-material/Download";
import DeleteSweepIcon from "@mui/icons-material/DeleteSweep";
import RefreshIcon from "@mui/icons-material/Refresh";
import FiberManualRecordIcon from "@mui/icons-material/FiberManualRecord";
import type { BackgroundState, GameSession } from "../types";

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

function SessionCard({
  session,
  isActive,
}: {
  session: GameSession;
  isActive: boolean;
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
        <Tooltip title="Download session JSON">
          <IconButton size="small" onClick={handleDownload}>
            <DownloadIcon fontSize="small" />
          </IconButton>
        </Tooltip>
      </Stack>

      <Stack direction="row" spacing={1} mt={0.5} flexWrap="wrap">
        <Chip label={`${p1} vs ${p2}`} size="small" variant="outlined" />
        <Chip
          label={`${snapCount} gamestates`}
          size="small"
          variant="outlined"
          color="primary"
        />
        <Chip
          label={`${eventCount} events`}
          size="small"
          variant="outlined"
        />
        <Chip
          label={formatDuration(session.startTime, session.endTime)}
          size="small"
          variant="outlined"
        />
      </Stack>
    </Box>
  );
}

export default function App() {
  const [state, setState] = useState<BackgroundState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

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

  function handleClearCompleted() {
    chrome.runtime.sendMessage({ type: "CLEAR_COMPLETED" }).then(refresh);
  }

  function handleDownloadAll() {
    chrome.runtime.sendMessage({ type: "DOWNLOAD_ALL" }).then((resp) => {
      const sessions = (resp as { sessions: GameSession[] }).sessions;
      downloadJson(sessions, `kt_all_sessions_${Date.now()}.json`);
    });
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
          <Chip label="Phase 0" size="small" color="warning" variant="outlined" />
        </Stack>
        <Tooltip title="Refresh">
          <IconButton size="small" onClick={refresh}>
            <RefreshIcon fontSize="small" />
          </IconButton>
        </Tooltip>
      </Stack>

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
              <SessionCard session={current} isActive />
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
                <SessionCard key={s.sessionId} session={s} isActive={false} />
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
        Observer mode — no data sent to server
      </Typography>
    </Box>
  );
}
