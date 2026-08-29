import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { DockerHostConfig } from "@fusion/core";
import "./DockerTlsConfig.css";

type DockerTlsValue = Pick<DockerHostConfig, "tlsVerify" | "tlsCaPath" | "tlsCertPath" | "tlsKeyPath">;

interface DockerTlsConfigProps {
  value?: DockerTlsValue;
  onChange: (tls: DockerTlsValue) => void;
}

export function DockerTlsConfig({ value, onChange }: DockerTlsConfigProps) {
  const { t } = useTranslation("app");
  const [enabled, setEnabled] = useState(Boolean(value?.tlsCaPath || value?.tlsCertPath || value?.tlsKeyPath || value?.tlsVerify));

  useEffect(() => {
    if (!enabled) {
      onChange({ tlsVerify: undefined, tlsCaPath: undefined, tlsCertPath: undefined, tlsKeyPath: undefined });
    }
  }, [enabled, onChange]);

  const tls = useMemo(() => ({ tlsVerify: value?.tlsVerify ?? true, tlsCaPath: value?.tlsCaPath ?? "", tlsCertPath: value?.tlsCertPath ?? "", tlsKeyPath: value?.tlsKeyPath ?? "" }), [value]);

  return (
    <div className="docker-tls-config">
      <label className="checkbox-label">
        <input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />
        {t("docker.useTls", "Use TLS")}
      </label>
      {enabled && (
        <div className="docker-tls-config__fields">
          <div className="docker-tls-config__field">
            <label htmlFor="docker-tls-ca-path">{t("docker.caPath", "CA Certificate Path")}</label>
            <input
              id="docker-tls-ca-path"
              className="input"
              value={tls.tlsCaPath}
              onChange={(event) => onChange({ ...tls, tlsCaPath: event.target.value })}
              placeholder="/etc/docker/ca.pem"
            />
          </div>
          <div className="docker-tls-config__field">
            <label htmlFor="docker-tls-cert-path">{t("docker.certPath", "Client Certificate Path")}</label>
            <input
              id="docker-tls-cert-path"
              className="input"
              value={tls.tlsCertPath}
              onChange={(event) => onChange({ ...tls, tlsCertPath: event.target.value })}
              placeholder="/etc/docker/cert.pem"
            />
          </div>
          <div className="docker-tls-config__field">
            <label htmlFor="docker-tls-key-path">{t("docker.keyPath", "Client Key Path")}</label>
            <input
              id="docker-tls-key-path"
              className="input"
              value={tls.tlsKeyPath}
              onChange={(event) => onChange({ ...tls, tlsKeyPath: event.target.value })}
              placeholder="/etc/docker/key.pem"
            />
          </div>
          <label className="checkbox-label">
            <input type="checkbox" checked={tls.tlsVerify} onChange={(event) => onChange({ ...tls, tlsVerify: event.target.checked })} />
            {t("docker.verifyTls", "Verify TLS Certificate")}
          </label>
        </div>
      )}
    </div>
  );
}
