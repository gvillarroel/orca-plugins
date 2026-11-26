# Instalar los plugins de este catálogo en Orca

Añade el catálogo una vez en el perfil de Orca que usas a diario. Después puedes elegir qué plugins instalar. Para usar **Pi Durable** en el chat nativo también necesitas su proveedor de Pi y el servicio local que guarda tus agentes.

## Añadir el catálogo e instalar el plugin

1. Abre **Settings → Plugins** en Orca Desktop. Si aparece **Turn on plugins**, actívalo.
2. Abre el menú de tres puntos **…** (**Plugin settings**) y selecciona **Catalog sources…**.
3. En **Git URL** pega `https://github.com/gvillarroel/orca-plugins.git`. En **Git ref** escribe `main`. Pulsa **Add source**. Cuando aparezca **Orca Plugins** entre los catálogos, cierra con **Done**.
4. En el filtro **All**, busca **Pi Durable** y selecciona **Review & install**. Comprueba que el editor es `gvillarroel`, revisa los permisos y pulsa **Install & enable**. El plugin ejecuta código local y usa el acceso al workspace y a los agentes para abrir Pi Chat. Su identificador es `gvillarroel.pi-durable`.

Puedes pulsar **Open panel** en la ficha del plugin o abrir un workspace local y seleccionar el icono de robot **Pi Durable** en la barra derecha. Se abrirá el panel **Agents**. Si te pide arrancar el servicio, continúa con el siguiente apartado.

## Preparar Pi Durable en Windows

Estos comandos se probaron con **Pi Durable 0.3.0**, **Orca Desktop 1.4.278**, **Node.js 24** con npm, **Git** y **Pi Coding Agent 1.4.0**. Ejecuta PowerShell con el mismo usuario de Windows que abre Orca. [Orca Desktop](https://github.com/stablyai/orca/releases/tag/v1.4.278) · [Node.js 24](https://nodejs.org/download/release/latest-v24.x/) · [Git para Windows](https://git-scm.com/install/windows)

En PowerShell puedes comprobar qué versiones tienes instaladas.

```powershell
git --version
node --version
npm --version
pi --version
```

Si te falta Pi, ejecuta `npm install -g @earendil-works/pi-coding-agent@1.4.0`. Comprueba que **Pi** aparece en **Settings → Agents** de Orca.

Para la primera instalación, descarga la versión en una carpeta estable y registra el proveedor desde la raíz de esa copia. Pi seguirá cargándolo desde allí.

```powershell
$destino = Join-Path $env:LOCALAPPDATA 'Programs\Orca Pi Durable\0.3.0'
git clone --single-branch --branch pi-durable-v0.3.0 https://github.com/gvillarroel/orca-plugins.git "$destino"
Set-Location -LiteralPath $destino
pi install ./integrations/pi-durable-provider
npm --prefix ./runtime ci
```

Inicia el servicio desde cualquier ventana de PowerShell y déjala abierta mientras usas los agentes. **Este mismo comando sirve después de reiniciar Windows.**

```powershell
npm --prefix "$env:LOCALAPPDATA\Programs\Orca Pi Durable\0.3.0\runtime" start
```

Espera el mensaje `Pi Durable is ready on this computer.` El servicio escucha en `127.0.0.1:47896`. Puedes detenerlo con **Ctrl+C**. Tus agentes y sus conversaciones se guardan en `%USERPROFILE%\.pi-durable-orca`. Si ya tenías una versión anterior, puedes actualizar la copia existente y conservar esos datos. [Actualizar una instalación anterior](../plugins/pi-durable/README.md#upgrade-an-existing-installation)

## Comprobar el primer chat

1. Abre un workspace local y selecciona el icono de robot **Pi Durable** en la barra derecha. Pulsa **Refresh**. En una instalación nueva verás **0 agents** y el botón **+ Recruit** disponible. [Ver el panel recién instalado](pi-durable/agents-panel.png)
2. Pulsa **+ Recruit**, escribe un nombre y selecciona el modelo **demo**, que funciona sin claves de API. Confirma con **Recruit agent**.
3. En la pestaña central de Pi Chat, escribe `Hola`. Si recibes `Demo echo: Hola`, el panel, el proveedor de Pi y el servicio local están conectados. [Ver un chat nativo en Orca](pi-durable/native-chat.png)

## Si el plugin no aparece

| Qué ves | Qué comprobar |
| --- | --- |
| La búsqueda en **Settings → Plugins** no devuelve Pi Durable | Abre **… → Catalog sources…** en ese mismo perfil. Debe figurar **Orca Plugins**, con la URL de `gvillarroel/orca-plugins.git` y la rama `main`. Vuelve a **All** y busca de nuevo. |
| Pi Durable figura como instalado, pero no ves el icono | Si su ficha muestra **Enable plugin**, púlsalo. Abre un workspace local y despliega la barra derecha. También puedes abrir el panel con el comando de abajo. |
| El panel pide iniciar el servicio | Ejecuta el comando de arranque anterior y pulsa **Refresh**. Si PowerShell indica que el puerto ya está en uso, comprueba primero si **Refresh** habilita **+ Recruit**. |
| Ves tu agente, pero el chat nativo no se abre | Con el servicio en ejecución y al menos un agente creado, ejecuta `pi --list-models pi-durable`. Busca el ID de tu agente. Si falta, repite `pi install ./integrations/pi-durable-provider` desde la copia descargada y verifica que Orca usa esa instalación de Pi. |

Con Orca Desktop abierto, este comando usa la ubicación habitual de Windows para abrir el panel en el workspace actual.

```powershell
& "$env:LOCALAPPDATA\Programs\Orca\resources\bin\orca.exe" plugin open gvillarroel.pi-durable --panel agents --environment local
```
