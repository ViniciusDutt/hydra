import "./network.scss";

import type { NetworkStatus, WifiNetwork } from "@types";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { CheckIcon, GlobeIcon } from "@phosphor-icons/react";
import { Button, FocusItem, Input, VerticalFocusGroup } from "../../components";
import { useNavigation } from "../../hooks";
import { SettingsSection } from "./settings-section";
import {
  NETWORK_REFRESH_BUTTON_ID,
  NETWORK_SECTION_REGION_ID,
  SETTINGS_HEADER_RETURN_TARGET,
  SETTINGS_SIDEBAR_RETURN_TARGET,
} from "./settings-navigation";

async function getNetworkStatus(): Promise<NetworkStatus> {
  let statusError: unknown;
  if (typeof globalThis.window.electron.getNetworkStatus === "function") {
    try {
      return await globalThis.window.electron.getNetworkStatus();
    } catch (error) {
      statusError = error;
    }
  }

  // Older installed versions keep their original preload when the UI updates.
  const interfaces = await globalThis.window.electron.getNetworkInterfaces();
  const ethernet = interfaces
    .filter(({ name }) =>
      /^(ethernet(?:\b|\d)|eth\d|en(?:o|p|s|x|d)\w*)/i.test(name)
    )
    .map(({ name }) => name);
  if (statusError && !ethernet.length) throw statusError;
  return {
    supported: false,
    hasWifi: false,
    ethernet,
    networks: [],
  };
}

export function NetworkSettingsSection({
  className,
}: Readonly<{ className?: string }>) {
  const { i18n } = useTranslation();
  const portuguese = i18n.language.startsWith("pt");
  const text = (english: string, portugueseText: string) =>
    portuguese ? portugueseText : english;
  const { setFocus } = useNavigation();
  const [status, setStatus] = useState<NetworkStatus | null>(null);
  const [selected, setSelected] = useState<WifiNetwork | null>(null);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [connecting, setConnecting] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setBusy(true);
    try {
      setStatus(await getNetworkStatus());
      setError(false);
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);
  useEffect(() => {
    if (!connecting) return;
    let cancelled = false;
    let attempts = 0;
    const interval = globalThis.window.setInterval(async () => {
      try {
        const next = await getNetworkStatus();
        if (cancelled) return;
        setStatus(next);
        if (
          next.networks.some(
            (network) => network.ssid === connecting && network.connected
          )
        ) {
          setConnecting(null);
        } else if (++attempts >= 6) {
          setConnecting(null);
          setError(true);
        }
      } catch {
        if (!cancelled) {
          setConnecting(null);
          setError(true);
        }
      }
    }, 5000);
    return () => {
      cancelled = true;
      globalThis.window.clearInterval(interval);
    };
  }, [connecting]);

  const connect = async (network: WifiNetwork) => {
    setBusy(true);
    setError(false);
    try {
      if (typeof globalThis.window.electron.connectWifi !== "function") {
        throw new Error("Network configuration requires an app update");
      }
      await globalThis.window.electron.connectWifi(network.ssid, password);
      setConnecting(network.ssid);
      setSelected(null);
      setPassword("");
      setFocus(NETWORK_REFRESH_BUTTON_ID);
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  };

  const networks = [
    ...new Map(
      status?.networks.map((network) => [network.ssid, network])
    ).values(),
  ].sort(
    (a, b) => Number(b.connected) - Number(a.connected) || b.signal - a.signal
  );

  return (
    <div
      className={
        className
          ? `network-settings-section ${className}`
          : "network-settings-section"
      }
    >
      <SettingsSection
        title={text("Network", "Internet")}
        description={text(
          "Manage your internet connection.",
          "Gerencie sua conexão com a internet."
        )}
      >
        <VerticalFocusGroup regionId={NETWORK_SECTION_REGION_ID} asChild>
          <div className="network-settings-section__content">
            {status && status.ethernet.length > 0 && (
              <div className="network-settings-section__active">
                <h3>{text("Active networks", "Redes ativas")}</h3>
                {status.ethernet.map((name, index) => (
                  <FocusItem
                    key={name}
                    id={
                      index === 0 && !status.hasWifi
                        ? NETWORK_REFRESH_BUTTON_ID
                        : `network-ethernet-${index}`
                    }
                    asChild
                    navigationOverrides={{
                      up: SETTINGS_HEADER_RETURN_TARGET,
                      left: SETTINGS_SIDEBAR_RETURN_TARGET,
                    }}
                  >
                    <div
                      className="network-settings-section__ethernet"
                      aria-label={`${text("Connected", "Conectado")}: ${name}`}
                    >
                      <CheckIcon
                        className="network-settings-section__connected"
                        size={28}
                        weight="bold"
                        aria-hidden
                      />
                      <span>Ethernet</span>
                      <GlobeIcon
                        className="network-settings-section__globe"
                        size={28}
                        aria-hidden
                      />
                    </div>
                  </FocusItem>
                ))}
              </div>
            )}
            {(!status || status.hasWifi || !status.ethernet.length) && (
              <Button
                focusId={NETWORK_REFRESH_BUTTON_ID}
                focusNavigationOverrides={{
                  up: SETTINGS_HEADER_RETURN_TARGET,
                  left: SETTINGS_SIDEBAR_RETURN_TARGET,
                }}
                disabled={busy || Boolean(connecting)}
                onClick={() => void refresh()}
              >
                {busy
                  ? text("Loading…", "Carregando…")
                  : text("Refresh", "Atualizar")}
              </Button>
            )}
            {error && (
              <p role="alert">
                {text(
                  "Could not scan or connect. Check the password, Wi-Fi permissions and system network settings, then try again.",
                  "Não foi possível buscar redes ou conectar. Confira a senha, as permissões de Wi-Fi e as configurações de rede do sistema e tente novamente."
                )}
              </p>
            )}
            {connecting && (
              <p role="status">
                {text("Connecting to", "Conectando a")} {connecting}…
              </p>
            )}
            {status && !status.supported && !status.ethernet.length && (
              <p>
                {text(
                  "Network configuration is unavailable on this system.",
                  "A configuração de rede não está disponível neste sistema."
                )}
              </p>
            )}
            {status?.supported &&
              !status.hasWifi &&
              !status.ethernet.length && (
                <p>
                  {text(
                    "No Wi-Fi adapter detected.",
                    "Nenhum adaptador Wi-Fi detectado."
                  )}
                  {!status.ethernet.length &&
                    ` ${text("No active Ethernet connection.", "Nenhuma conexão Ethernet ativa.")}`}
                </p>
              )}
            {status?.hasWifi && (
              <>
                <p>Wi-Fi</p>
                {!networks.length && (
                  <p>
                    {text(
                      "No networks found. Check that Wi-Fi is enabled in your system settings.",
                      "Nenhuma rede encontrada. Confira se o Wi-Fi está ativado nas configurações do sistema."
                    )}
                  </p>
                )}
                {networks.map((network, index) => (
                  <Button
                    key={network.ssid}
                    focusId={`network-wifi-${index}`}
                    variant="secondary"
                    disabled={busy || Boolean(connecting) || network.connected}
                    onClick={() => {
                      setSelected(network);
                      setPassword("");
                      setError(false);
                      globalThis.window.requestAnimationFrame(() =>
                        setFocus(
                          network.security
                            ? "network-password"
                            : "network-connect"
                        )
                      );
                    }}
                  >
                    {network.ssid} · {network.signal}% ·{" "}
                    {network.connected
                      ? text("Connected", "Conectado")
                      : network.security || text("Open", "Aberta")}
                  </Button>
                ))}
              </>
            )}
            {selected && (
              <form
                className="network-settings-section__connection"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (!busy) void connect(selected);
                }}
              >
                <p>{selected.ssid}</p>
                {selected.security && (
                  <Input
                    focusId="network-password"
                    type="password"
                    label={text("Password", "Senha")}
                    placeholder={text("Wi-Fi password", "Senha do Wi-Fi")}
                    autoComplete="off"
                    maxLength={64}
                    value={password}
                    disabled={busy}
                    onChange={(event) => setPassword(event.target.value)}
                  />
                )}
                <Button
                  focusId="network-connect"
                  type="submit"
                  disabled={busy || Boolean(selected.security && !password)}
                >
                  {text("Connect", "Conectar")}
                </Button>
                <Button
                  focusId="network-cancel"
                  type="button"
                  variant="secondary"
                  disabled={busy}
                  onClick={() => {
                    setSelected(null);
                    setPassword("");
                    setFocus(NETWORK_REFRESH_BUTTON_ID);
                  }}
                >
                  {text("Cancel", "Cancelar")}
                </Button>
              </form>
            )}
          </div>
        </VerticalFocusGroup>
      </SettingsSection>
    </div>
  );
}
