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
    byId("dbCreate").setAttribute("disabled", "");
    byId("dbCreateForm").hidden = true;
    byId("dbSecurity").textContent = "Autenticação do banco ainda não verificada.";
    byId("dbRolesBody").replaceChildren();
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
  function renderRoles(roles) {
    const rows = roles.map((role) => {
      const tr = document.createElement("tr");
      const project = /^u_[a-z][a-z0-9_]*$/.test(role.name)
        ? role.name.slice(2).replaceAll("_", "-") + " (pelo nome)" : "Não associado";
      for (const value of [role.name, project, role.superuser ? "Superusuário" : "Sem privilégios de superusuário",
        role.canLogin ? "Login habilitado" : "Sem login"]) {
        const td = document.createElement("td");
        td.textContent = value;
        tr.append(td);
      }
      return tr;
    });
    byId("dbRolesBody").replaceChildren(...rows);
  }
  const createButton = byId("dbCreate");
  const createForm = byId("dbCreateForm");
  const projectInput = byId("dbProjectSlug");
  createButton.addEventListener("click", () => {
    if (createButton.disabled) return;
    createForm.hidden = false;
    projectInput.focus();
  });
  byId("dbCreateCancel").addEventListener("click", () => { createForm.hidden = true; });
  createForm.addEventListener("submit", event => {
    event.preventDefault();
    const project = projectInput.value.trim();
    if (!/^[a-z][a-z0-9-]{1,29}$/.test(project)) {
      byId("dbCreateResult").textContent = "Use 2 a 30 caracteres: letras minúsculas, números e traços.";
      return;
    }
    if (!confirm('Criar banco e conta PostgreSQL para "' + project +
      '"? As credenciais serão geradas e guardadas na VPS.')) return;
    void (async () => {
      const submit = byId("dbCreateSubmit");
      submit.disabled = true;
      try {
        const response = await window.panelApi.request("/database/projects", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ project })
        });
        byId("dbCreateResult").textContent = "Criado: " + response.database + " · usuário: " +
          response.username + ". Senha guardada somente na VPS.";
        createForm.hidden = true;
        projectInput.value = "";
        await refreshDatabasePanel();
      } catch (error) {
        byId("dbCreateResult").textContent = error instanceof Error ? error.message :
          "Não foi possível criar o banco. Verifique a situação antes de repetir.";
      } finally { submit.disabled = false; }
    })();
  });
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
        byId("dbMessage").textContent = "Versão " + data.instance.version +
          ". Inventário real do PostgreSQL compartilhado.";
        const policy = data.security;
        const enabled = policy?.provisioningEnabled === true;
        createButton.disabled = !enabled;
        byId("dbSecurity").textContent = policy?.message ??
          "A política de autenticação ainda não foi verificada. Criação bloqueada.";
        byId("dbService").textContent = "Conectado";
        byId("dbCount").textContent = String(data.metrics.databaseCount);
        byId("dbStorage").textContent = formatBytes(data.metrics.totalBytes);
        byId("dbConnections").textContent = String(data.metrics.connections);
        byId("dbOperations").textContent = enabled ? "Criação protegida habilitada" : "Somente leitura";
        renderInventory(data.databases);
        renderRoles(Array.isArray(data.roles) ? data.roles : []);
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
