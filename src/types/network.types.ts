export interface WifiNetwork {
  ssid: string;
  security: string;
  signal: number;
  connected: boolean;
}

export interface NetworkStatus {
  supported: boolean;
  hasWifi: boolean;
  ethernet: string[];
  networks: WifiNetwork[];
}
