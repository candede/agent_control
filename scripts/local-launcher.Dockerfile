ARG POWERSHELL_BASE=mcr.microsoft.com/powershell:7.5-azurelinux-3.0
FROM docker:29-cli AS docker-cli
FROM ${POWERSHELL_BASE}
RUN tdnf install -y git ca-certificates coreutils && tdnf clean all
COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker
COPY --from=docker-cli /usr/local/libexec/docker/cli-plugins /usr/local/libexec/docker/cli-plugins
ENV POWERSHELL_TELEMETRY_OPTOUT=1 POWERSHELL_UPDATECHECK=Off DOTNET_EnableDiagnostics=0
LABEL io.agent-control.purpose=local-deployment-launcher
ENTRYPOINT ["pwsh"]
