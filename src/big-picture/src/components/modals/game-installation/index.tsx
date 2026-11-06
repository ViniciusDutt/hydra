import { WarningIcon } from "@phosphor-icons/react";
import type { LibraryGame } from "@types";
import { useTranslation } from "react-i18next";

import { Button, Modal, Typography, VerticalFocusGroup } from "../../common";
import "./styles.scss";

interface GameInstallationModalProps {
  visible: boolean;
  game: LibraryGame | null;
  progress: number;
  onBackground: () => void;
}

export function GameInstallationModal({
  visible,
  game,
  progress,
  onBackground,
}: Readonly<GameInstallationModalProps>) {
  const { t } = useTranslation("downloads");
  const profileName =
    game?.download?.installerProfile === "fitgirl-inno"
      ? "FitGirl"
      : t("installer_profile_automatic");

  return (
    <Modal
      visible={visible}
      onClose={onBackground}
      title={t("silent_install_title", { title: game?.title ?? "" })}
      description={t("silent_install_description", { profile: profileName })}
      closeOnBackdrop={false}
      closeOnEscape={false}
      closeOnB={false}
      className="game-installation-modal"
    >
      <div className="game-installation-modal__progress" role="progressbar">
        <div
          className={`game-installation-modal__progress-bar ${progress > 0 ? "game-installation-modal__progress-bar--determinate" : ""}`}
          style={progress > 0 ? { width: `${progress}%` } : undefined}
        />
      </div>

      <Typography className="game-installation-modal__status">
        {progress > 0
          ? t("silent_install_running", { progress })
          : t("silent_install_starting")}
      </Typography>

      <div className="game-installation-modal__warning">
        <WarningIcon size={24} weight="fill" />
        <Typography>{t("silent_install_performance_warning")}</Typography>
      </div>

      <VerticalFocusGroup
        regionId="game-installation-modal-actions"
        className="game-installation-modal__actions"
      >
        <Button variant="secondary" onClick={onBackground}>
          {t("silent_install_background")}
        </Button>
      </VerticalFocusGroup>
    </Modal>
  );
}
