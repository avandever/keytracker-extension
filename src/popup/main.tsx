import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { CssBaseline, ThemeProvider, createTheme } from "@mui/material";
import App from "./App";

const theme = createTheme({
  palette: {
    mode: "dark",
    primary: { main: "#1976d2" },
    secondary: { main: "#f57c00" },
    background: { default: "#121212", paper: "#1e1e1e" },
  },
  typography: { fontSize: 13 },
  components: {
    MuiChip: { styleOverrides: { root: { height: 22, fontSize: 11 } } },
  },
});

const root = createRoot(document.getElementById("root")!);
root.render(
  <StrictMode>
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <App />
    </ThemeProvider>
  </StrictMode>
);
