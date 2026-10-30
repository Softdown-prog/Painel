(() => {
  const byId = (id) => document.getElementById(id);
  const tabs = Array.from(document.querySelectorAll("[data-db-tab]"));
  let inFlight = false;
  function selectTab(name, focus = false) {
    for (const tab of tabs) {
      const active = tab.dataset.dbTab === name;
      tab.setAttribute("aria-selected", String(active));
      tab.tabIndex = active ? 0 : -1;
      byId(tab.getAttribute("aria-controls")).hidden = !active;
      if (active && focus) tab.focus();
    }
  }
  for (const tab of tabs) {
    tab.addEventListener("click", () => selectTab(tab.dataset.dbTab));
    tab.addEventListener("keydown", (event) => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      const idx = tabs.indexOf(tab);
      const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1
        : (idx + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
      selectTab(tabs[next].dataset.dbTab, true);
    });
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
  }
  async function refreshDatabasePanel() {
    if (inFlight) return;
    inFlight = true;
    const refresh = byId("dbRefresh");
    refresh.disabled = true;
    setUnavailable("Consultando API da VPS…", "Verificando se a integração foi configurada.", "Verificando");
    byId("dbLastCheck").textContent = "Consulta em andamento";
    try {
      const data = await window.panelApi.request("/database/status");
      if (!data || data.engine !== "postgresql" || data.integration !== "not_configured"
        || data.enabled !== false || data.instance !== null || data.databases !== null
        || !Number.isFinite(Date.parse(data.checkedAt))) {
        throw new Error("A API retornou um contrato de banco de dados inesperado.");
      }
      setUnavailable("PostgreSQL ainda não conectado",
        "A seção de administração está preparada, mas ainda não há integração com o banco. Nenhuma instalação ou consulta SQL foi executada.",
        "Não configurado");
      byId("dbLastCheck").textContent = "API respondeu em " + new Date(data.checkedAt).toLocaleString("pt-BR");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Resposta indisponível.";
      setUnavailable("Não foi possível confirmar o estado",
        "A conexão com a API falhou. Não é possível afirmar se o servidor possui PostgreSQL. " + message,
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
