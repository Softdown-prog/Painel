(() => {
  const byId = (id) => document.getElementById(id)!;
  const tabs = Array.from(document.querySelectorAll("[data-db-tab]"));
  let inFlight = false;
  function selectTab(name, focus = false) {
    for (const tab of tabs) {
      const active = tab.dataset.dbTab === name;
      tab.setAttribute("aria-selected", String(active));
      tab.tabIndex = active ? 0 : -1;
      byId(tab.getAttribute("aria-controls")!).hidden = !active;
      if (active && focus) tab.focus();
    }
  }
  for (const tab of tabs) {
    tab.addEventListener("click", () => selectTab(tab.dataset.dbTab!));
    tab.addEventListener("keydown", (event) => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      const idx = tabs.indexOf(tab);
      const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1
        : (idx + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
      selectTab(tabs[next].dataset.dbTab!, true);
    });
  }
  function emptyInventory(message) {
    const row = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = 5;
    cell.className = "database-empty";
    cell.textContent = message;
    row.append(cell);
    byId("dbProjectsBody").replaceChildren(row);
  }
  function setUnavailable(title, message, reason, state = "unconfigured") {
    byId("dbStatusCard").dataset.state = state;
    byId("dbStatus").textContent = title;
    byId("dbMessage").textContent = message;
    byId("dbService").textContent = reason;
    byId("dbCount").textContent = "—";
    byId("dbStorage").textContent = "—";
    byId("dbConnections").textContent = "—";
    byId("dbOperations").textContent = "Desativadas";
    emptyInventory("Nenhuma lista de bancos disponível nesta consulta.");
  }
  function formatBytes(value) {
    if (!Number.isFinite(value) || value < 0) return "—";
    if (value < 1024) return value + " B";
    const units = ["KB", "MB", "GB", "TB", "PB"];
    let amount = value;
    let index = -1;
    do { amount /= 1024; index++; } while (amount >= 1024 && index < units.length - 1);
    return amount.toLocaleString("pt-BR", { maximumFractionDigits: 1 }) + " " + units[index];
  }
  function renderInventory(databases) {
    if (!databases.length) { emptyInventory("Nenhum banco encontrado."); return; }
    const rows = databases.map((db) => {
      const row = document.createElement("tr");
      // Bancos e projetos cadastrados no Painel não possuem vínculo automático.
      for (const value of ["Não associado", db.name, formatBytes(db.sizeBytes), "Disponível", "Somente leitura"]) {
        const cell = document.createElement("td");
        cell.textContent = value;
        row.append(cell);
      }
      row.title = "Proprietário PostgreSQL: " + db.owner;
      return row;
    });
    byId("dbProjectsBody").replaceChildren(...rows);
  }
  async function refreshDatabasePanel() {
    if (inFlight) return;
    inFlight = true;
    const refresh = byId("dbRefresh");
    refresh.disabled = true;
    setUnavailable("Consultando API da VPS…", "Verificando conexão com PostgreSQL.", "Verificando");
    byId("dbLastCheck").textContent = "Consulta em andamento";
    try {
      const data = await window.panelApi.request("/database/status");
      if (!data || data.engine !== "postgresql" || !Number.isFinite(Date.parse(data.checkedAt))) {
        throw new Error("A API retornou um contrato de banco inesperado.");
      }
      if (data.integration === "connected" && data.enabled === true && data.instance
          && Array.isArray(data.databases) && data.metrics
          && Number.isFinite(data.metrics.databaseCount) && Number.isFinite(data.metrics.connections)
          && Number.isFinite(data.metrics.totalBytes)) {
        byId("dbStatusCard").dataset.state = "connected";
        byId("dbStatus").textContent = "PostgreSQL conectado";
        byId("dbMessage").textContent = "Versão " + data.instance.version
          + ". Consulta real; criação e exclusão de bancos ainda não estão habilitadas.";
        byId("dbService").textContent = "Conectado";
        byId("dbCount").textContent = String(data.metrics.databaseCount);
        byId("dbStorage").textContent = formatBytes(data.metrics.totalBytes);
        byId("dbConnections").textContent = String(data.metrics.connections);
        byId("dbOperations").textContent = "Somente leitura";
        renderInventory(data.databases);
      } else if (data.integration === "not_configured" && data.enabled === false) {
        setUnavailable("Conector ainda não habilitado",
          "O PostgreSQL pode estar instalado, mas a API do Painel ainda não foi conectada à rede privada.",
          "Não configurado");
      } else if (data.integration === "unavailable" && data.enabled === true) {
        setUnavailable("PostgreSQL indisponível", data.message, "Sem conexão", "unknown");
      } else {
        throw new Error("A API retornou um estado de banco inesperado.");
      }
      byId("dbLastCheck").textContent = "API consultada em " + new Date(data.checkedAt).toLocaleString("pt-BR");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Resposta indisponível.";
      setUnavailable("Não foi possível confirmar o estado",
        "A API não respondeu corretamente. Não é possível confirmar a conexão com PostgreSQL. " + message,
        "Não verificado", "unknown");
      byId("dbLastCheck").textContent = "Sem verificação confirmada";
    } finally {
      refresh.disabled = false;
      inFlight = false;
    }
  }
  byId("dbRefresh").addEventListener("click", () => void refreshDatabasePanel());
  Object.assign(window, { refreshDatabasePanel });
})();
