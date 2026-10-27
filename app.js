"use strict";

const $ = (id) => document.getElementById(id);

// Roblox's own "Baseplate" template. Every new game starts as a copy of it,
// then gets overwritten with your file. (Same template Rojo/Mantle use.)
const TEMPLATE_PLACE_ID = 95206881;

let csrfToken = null;
let currentUser = null;
let mode = "new"; // "new" | "existing"
let busy = false;
let autoName = ""; // last name we filled in from the file name

/* ------------------------------------------------------------------ */
/* Network                                                            */
/* ------------------------------------------------------------------ */

// Requests from this page should look like they come from roblox.com, and the
// place upload endpoint expects Roblox Studio's user agent. These rules only
// apply to requests this extension makes, never to your normal browsing.
async function installHeaderRules() {
  const self = [chrome.runtime.id];
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [1, 2],
    addRules: [
      {
        id: 1,
        priority: 1,
        action: {
          type: "modifyHeaders",
          requestHeaders: [
            { header: "Origin", operation: "set", value: "https://www.roblox.com" },
            { header: "Referer", operation: "set", value: "https://www.roblox.com/" },
          ],
        },
        condition: {
          initiatorDomains: self,
          requestDomains: ["roblox.com"],
          excludedRequestDomains: ["data.roblox.com"],
          resourceTypes: ["xmlhttprequest"],
        },
      },
      {
        id: 2,
        priority: 1,
        action: {
          type: "modifyHeaders",
          requestHeaders: [
            { header: "User-Agent", operation: "set", value: "Roblox/WinInet" },
            { header: "Origin", operation: "set", value: "https://www.roblox.com" },
            { header: "Referer", operation: "set", value: "https://www.roblox.com/" },
          ],
        },
        condition: {
          initiatorDomains: self,
          requestDomains: ["data.roblox.com"],
          resourceTypes: ["xmlhttprequest"],
        },
      },
    ],
  });
}

// fetch() with your Roblox session cookies, handling Roblox's CSRF handshake:
// a write request first gets 403 + x-csrf-token, then succeeds when repeated
// with that token.
async function rbx(url, options = {}, canRetry = true) {
  const headers = { Accept: "application/json", ...(options.headers || {}) };
  if (csrfToken) headers["x-csrf-token"] = csrfToken;

  const res = await fetch(url, { ...options, headers, credentials: "include" });

  const freshToken = res.headers.get("x-csrf-token");
  if (res.status === 403 && freshToken && canRetry) {
    csrfToken = freshToken;
    return rbx(url, options, false);
  }
  return res;
}

async function readBody(res) {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function describeError(res, body) {
  let detail = "";
  if (body && typeof body === "object") {
    if (Array.isArray(body.errors) && body.errors.length) {
      detail = body.errors
        .map((e) => e.userFacingMessage || e.message || JSON.stringify(e))
        .join("; ");
    } else if (body.message) {
      detail = body.message;
    } else if (body.errorMessage) {
      detail = body.errorMessage;
    }
  } else if (typeof body === "string") {
    detail = body.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 240);
  }

  let msg = "HTTP " + res.status + (detail ? " – " + detail : "");
  if (res.status === 401) msg += " (you're signed out — sign in on roblox.com and try again)";
  return msg;
}

async function rbxJson(url, options) {
  const res = await rbx(url, options);
  const body = await readBody(res);
  if (!res.ok) throw new Error(describeError(res, body));
  return body;
}

const jsonPost = (method, data) => ({
  method,
  headers: { "Content-Type": "application/json" },
  body: data === undefined ? undefined : JSON.stringify(data),
});

/* ------------------------------------------------------------------ */
/* Roblox actions                                                     */
/* ------------------------------------------------------------------ */

async function createUniverse(groupId) {
  let url = "https://apis.roblox.com/universes/v1/universes/create";
  if (groupId) url += "?groupId=" + encodeURIComponent(groupId);
  const data = await rbxJson(url, jsonPost("POST", { templatePlaceId: TEMPLATE_PLACE_ID }));
  if (!data || !data.universeId || !data.rootPlaceId) {
    throw new Error("Roblox didn't return the new game's IDs.");
  }
  return { universeId: data.universeId, placeId: data.rootPlaceId };
}

async function uploadPlaceFile(placeId, file) {
  const bytes = await file.arrayBuffer();
  const res = await rbx(
    "https://data.roblox.com/Data/Upload.ashx?assetid=" + encodeURIComponent(placeId),
    {
      method: "POST",
      // Roblox accepts both binary .rbxl and XML .rbxlx with this type (same as Rojo).
      headers: { "Content-Type": "application/xml" },
      body: bytes,
    }
  );
  const body = await readBody(res);
  if (!res.ok) throw new Error(describeError(res, body));
  return body; // usually the new version number
}

async function renamePlace(placeId, name, description) {
  const payload = { name };
  if (description) payload.description = description;
  try {
    await rbxJson("https://develop.roblox.com/v2/places/" + placeId, jsonPost("PATCH", payload));
  } catch (err) {
    // Older endpoint as a fallback.
    await rbxJson("https://develop.roblox.com/v1/places/" + placeId, jsonPost("PATCH", payload));
  }
}

async function makePublic(universeId) {
  await rbxJson("https://develop.roblox.com/v1/universes/" + universeId + "/activate", {
    method: "POST",
  });
}

async function getUniverseIdForPlace(placeId) {
  try {
    const data = await rbxJson(
      "https://apis.roblox.com/universes/v1/places/" + placeId + "/universe"
    );
    return data && data.universeId ? data.universeId : null;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Sign-in                                                            */
/* ------------------------------------------------------------------ */

function setAccount(state, text) {
  $("account").dataset.state = state;
  $("accountText").textContent = text;
  $("recheck").hidden = state === "in" || state === "checking";
  $("signedOut").hidden = state !== "out";
  if (state !== "in") $("avatar").hidden = true;
  refreshButton();
}

async function checkSignIn() {
  setAccount("checking", "Checking sign-in…");
  try {
    const res = await rbx("https://users.roblox.com/v1/users/authenticated");
    if (res.status === 401) {
      currentUser = null;
      setAccount("out", "Not signed in");
      return;
    }
    if (!res.ok) throw new Error(describeError(res, await readBody(res)));
    currentUser = await res.json();
    setAccount("in", "Signed in as " + (currentUser.displayName || currentUser.name) +
      (currentUser.displayName && currentUser.displayName !== currentUser.name ? " (@" + currentUser.name + ")" : ""));
    loadAvatar();
    loadGroups();
  } catch (err) {
    currentUser = null;
    setAccount("error", "Couldn't reach Roblox: " + err.message);
  }
}

async function loadAvatar() {
  try {
    const data = await rbxJson(
      "https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=" +
        currentUser.id + "&size=48x48&format=Png&isCircular=true"
    );
    const url = data && data.data && data.data[0] && data.data[0].imageUrl;
    if (url) {
      $("avatar").src = url;
      $("avatar").hidden = false;
    }
  } catch {
    /* avatar is just decoration */
  }
}

async function loadGroups() {
  const select = $("owner");
  try {
    const data = await rbxJson(
      "https://groups.roblox.com/v1/users/" + currentUser.id + "/groups/roles"
    );
    const groups = (data && data.data) || [];
    select.length = 1; // keep "My account"
    groups
      .sort((a, b) => (b.role.rank - a.role.rank) || a.group.name.localeCompare(b.group.name))
      .forEach(({ group, role }) => {
        const opt = document.createElement("option");
        opt.value = group.id;
        opt.textContent = "Group: " + group.name + (role.rank === 255 ? " (owner)" : "");
        select.appendChild(opt);
      });
  } catch {
    /* groups are optional */
  }
}

/* ------------------------------------------------------------------ */
/* UI                                                                 */
/* ------------------------------------------------------------------ */

function selectedFile() {
  return $("file").files[0] || null;
}

function refreshButton() {
  const file = selectedFile();
  let ready = !busy && !!currentUser && !!file;
  if (mode === "new") ready = ready && $("name").value.trim().length > 0;
  if (mode === "existing") ready = ready && /^\d+$/.test($("existingPlaceId").value.trim());
  $("go").disabled = !ready;
  $("go").textContent = busy
    ? "Working…"
    : mode === "new" ? "Create game" : "Upload to this game";
}

function setMode(next) {
  mode = next;
  document.querySelectorAll(".tab").forEach((t) =>
    t.setAttribute("aria-selected", String(t.dataset.mode === next))
  );
  document.querySelector(".only-new").hidden = next !== "new";
  document.querySelector(".only-existing").hidden = next !== "existing";
  refreshButton();
}

function onFileChosen() {
  const file = selectedFile();
  const drop = $("drop");
  if (!file) {
    drop.classList.remove("has-file");
    $("fileTitle").textContent = "Choose your .rbxl file";
    $("fileSub").textContent = "or drop it here";
  } else {
    drop.classList.add("has-file");
    $("fileTitle").textContent = file.name;
    $("fileSub").textContent = formatSize(file.size) + " · click to change";
    const base = file.name.replace(/\.rbxlx?$/i, "").slice(0, 50);
    const nameEl = $("name");
    if (!nameEl.value.trim() || nameEl.value === autoName) {
      nameEl.value = base;
      autoName = base;
    }
  }
  refreshButton();
}

function formatSize(bytes) {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / 1024 / 1024).toFixed(1) + " MB";
}

/* Step list ---------------------------------------------------------- */

function showSteps(list) {
  const ol = $("steps");
  ol.innerHTML = "";
  for (const s of list) {
    const li = document.createElement("li");
    li.id = "step-" + s.key;
    li.dataset.state = "pending";
    const dot = document.createElement("span");
    dot.className = "dot";
    const label = document.createElement("span");
    label.textContent = s.label;
    const note = document.createElement("span");
    note.className = "note";
    li.append(dot, label, note);
    ol.appendChild(li);
  }
  $("progress").hidden = false;
  $("links").hidden = true;
  setMessage("");
}

function setStep(key, state, note) {
  const li = $("step-" + key);
  if (!li) return;
  li.dataset.state = state;
  li.querySelector(".note").textContent = note || "";
}

function setMessage(text, kind) {
  const m = $("message");
  m.textContent = text;
  m.className = "message" + (kind ? " " + kind : "");
}

function showLinks(placeId, universeId) {
  $("playLink").href = "https://www.roblox.com/games/" + placeId;
  if (universeId) {
    $("dashLink").href =
      "https://create.roblox.com/dashboard/creations/experiences/" + universeId + "/overview";
    $("dashLink").hidden = false;
  } else {
    $("dashLink").hidden = true;
  }
  $("links").hidden = false;
}

/* ------------------------------------------------------------------ */
/* Main flows                                                         */
/* ------------------------------------------------------------------ */

async function runCreateNew() {
  const file = selectedFile();
  const name = $("name").value.trim();
  const description = $("description").value.trim();
  const groupId = $("owner").value;
  const wantPublic = $("makePublic").checked;

  showSteps([
    { key: "create", label: "Create a new game" },
    { key: "upload", label: "Upload " + file.name },
    { key: "name", label: 'Name it "' + name + '"' },
    { key: "public", label: wantPublic ? "Make it public" : "Keep it private (you can publish later)" },
  ]);

  let ids;
  setStep("create", "working");
  try {
    ids = await createUniverse(groupId);
    setStep("create", "done", "Place ID " + ids.placeId + " · Universe ID " + ids.universeId);
  } catch (err) {
    setStep("create", "failed", err.message);
    setMessage("Couldn't create the game. Nothing was changed on your account.", "err");
    return;
  }

  setStep("upload", "working");
  try {
    const version = await uploadPlaceFile(ids.placeId, file);
    const v = typeof version === "number" || /^\d+$/.test(String(version).trim())
      ? "Version " + String(version).trim()
      : "";
    setStep("upload", "done", v);
  } catch (err) {
    setStep("upload", "failed", err.message);
    ["name", "public"].forEach((k) => setStep(k, "skipped"));
    setMessage(
      "The game was created, but uploading your file failed. You can retry from the " +
        "\"Update existing game\" tab — I've filled in the Place ID (" + ids.placeId + ").",
      "err"
    );
    $("existingPlaceId").value = ids.placeId;
    showLinks(ids.placeId, ids.universeId);
    return;
  }

  setStep("name", "working");
  try {
    await renamePlace(ids.placeId, name, description);
    setStep("name", "done");
  } catch (err) {
    setStep("name", "warn", "Roblox rejected the name: " + err.message + ". You can rename it in the Creator Dashboard.");
  }

  if (wantPublic) {
    setStep("public", "working");
    try {
      await makePublic(ids.universeId);
      setStep("public", "done");
    } catch (err) {
      setStep("public", "warn",
        err.message + ". Roblox may need you to fill in the game's maturity questionnaire first — do that in the Creator Dashboard, then make it public there.");
    }
  } else {
    setStep("public", "done");
  }

  setMessage("Your game is ready!", "ok");
  showLinks(ids.placeId, ids.universeId);
}

async function runUpdateExisting() {
  const file = selectedFile();
  const placeId = $("existingPlaceId").value.trim();

  showSteps([{ key: "upload", label: "Upload " + file.name + " to place " + placeId }]);
  setStep("upload", "working");
  try {
    const version = await uploadPlaceFile(placeId, file);
    const v = /^\d+$/.test(String(version).trim()) ? "Version " + String(version).trim() : "";
    setStep("upload", "done", v);
    setMessage("Uploaded! The game now has your file's contents.", "ok");
    showLinks(placeId, await getUniverseIdForPlace(placeId));
  } catch (err) {
    setStep("upload", "failed", err.message);
    setMessage(
      err.message.startsWith("HTTP 403") || err.message.startsWith("HTTP 401")
        ? "Upload refused. Make sure that place belongs to the account (or a group you can edit) you're signed into."
        : "Upload failed.",
      "err"
    );
  }
}

/* ------------------------------------------------------------------ */
/* Wire-up                                                            */
/* ------------------------------------------------------------------ */

$("form").addEventListener("submit", async (e) => {
  e.preventDefault();
  if ($("go").disabled) return;
  busy = true;
  refreshButton();
  try {
    if (mode === "new") await runCreateNew();
    else await runUpdateExisting();
  } catch (err) {
    setMessage("Something went wrong: " + err.message, "err");
  } finally {
    busy = false;
    refreshButton();
  }
});

$("file").addEventListener("change", onFileChosen);
$("name").addEventListener("input", refreshButton);
$("existingPlaceId").addEventListener("input", refreshButton);
$("recheck").addEventListener("click", checkSignIn);
document.querySelectorAll(".tab").forEach((t) =>
  t.addEventListener("click", () => !busy && setMode(t.dataset.mode))
);

// Drag-and-drop styling (the file input itself handles the drop).
const drop = $("drop");
["dragenter", "dragover"].forEach((ev) =>
  drop.addEventListener(ev, () => drop.classList.add("over"))
);
["dragleave", "drop"].forEach((ev) =>
  drop.addEventListener(ev, () => drop.classList.remove("over"))
);

// Re-check sign-in when you come back from signing in on roblox.com.
window.addEventListener("focus", () => {
  if (!currentUser && !busy) checkSignIn();
});

(async () => {
  try {
    await installHeaderRules();
  } catch (err) {
    console.warn("Header rules not installed:", err);
  }
  await checkSignIn();
})();
