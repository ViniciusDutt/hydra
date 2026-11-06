import { connectWifi, getNetworkStatus } from "@main/services/network";
import { registerEvent } from "../register-event";

registerEvent("getNetworkStatus", getNetworkStatus);
registerEvent("connectWifi", (_event, ssid: string, password: string) =>
  connectWifi(ssid, password)
);
