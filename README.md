# Orca Plugins

**Pi Durable** añade a Orca un panel en español para reclutar agentes, editar sus instrucciones y retomar su chat haciendo clic en el nombre. Los agentes administrados por el plugin tienen un ID estable y una conversación guardada en SQLite. También puedes abrir agentes de servicios locales que implementen la API de la consola Pi Durable v1.

## Instalar Pi Durable

Necesitas **Orca Desktop 1.4.278 o posterior**, **Node.js 24 o posterior**, npm y Git. El panel se distribuye mediante el catálogo de este repositorio. El servicio se ejecuta en el mismo equipo que Orca Desktop.

**1. Descarga e inicia el servicio.** En PowerShell o en una terminal:

```sh
git clone --branch pi-durable-v0.1.1 https://github.com/gvillarroel/orca-plugins.git
cd orca-plugins/runtime
npm ci
npm start
```

Deja abierta la terminal mientras usas tus agentes. Cuando veas **Pi Durable está listo en este equipo**, abre Orca. En sesiones posteriores basta con ejecutar `npm start` desde la misma carpeta. Cerrar Orca no detiene el servicio. Para detenerlo, usa **Ctrl+C** en esa terminal.

**2. Añade el catálogo.** En Orca abre **Settings → Plugins → Add marketplace** e introduce estos valores:

| Campo | Valor |
| --- | --- |
| URL | `https://github.com/gvillarroel/orca-plugins.git` |
| Ref | `main` |

En el catálogo **Orca Plugins**, selecciona **Pi Durable → Install** y revisa el permiso para ejecutar el worker local. Abre **Pi Durable** en la barra lateral derecha. El worker comunica el panel con el servicio de este equipo. [Cómo funcionan los catálogos de Orca](https://github.com/stablyai/orca/blob/v1.4.278/docs/reference/plugin-catalog.md)

**3. Prueba el primer chat.** Pulsa **Reclutar**, escribe un nombre, por ejemplo *Revisor*, y elige `demo` como modelo. Puedes fijar el ID `revisor` o dejar que el servicio asigne uno. Guarda el agente, escribe `Hola` y envía. El modelo de demostración devuelve un eco local. Vuelve al listado, selecciona el mismo agente y verás el intercambio anterior. **Editar** permite cambiar el nombre, las instrucciones y el modelo conservando el ID y el historial.

### Actualizar desde 0.1.0

Actualiza **Pi Durable** desde **Settings → Plugins**. Para actualizar también el servicio local, detenlo con **Ctrl+C** y ejecuta estos comandos desde la raíz de tu copia de `orca-plugins`. Los perfiles y el historial están en tu directorio de usuario y se vuelven a abrir al arrancar.

```sh
git fetch origin tag pi-durable-v0.1.1
git switch --detach pi-durable-v0.1.1
cd runtime
npm ci
npm start
```

### Usar un modelo real

El selector ofrece `demo` y los modelos de la tabla para los que el servicio detecta una clave. Configura la variable en la terminal o con tu gestor de secretos **antes de arrancar o reiniciar el servicio**, y pulsa **Actualizar** en el panel. La aceptación de la clave y el acceso al modelo se comprueban al enviar un mensaje. Con un proveedor remoto, el contexto de la conversación se envía al proveedor que elijas.

| Modelo | Variable del servicio |
| --- | --- |
| `openai/gpt-4.1-mini` | `OPENAI_API_KEY` |
| `anthropic/claude-sonnet-4-6` | `ANTHROPIC_API_KEY` |

### Conectar agentes que ya existen

En **Settings → Plugins → Pi Durable**, establece **Registro externo** con la ruta absoluta local de tu archivo `durable-agents.json`. Por ejemplo, un archivo `.pi/durable-agents.json` de un proyecto puede tener esta estructura:

```json
{
  "version": 1,
  "services": [
    { "id": "equipo", "name": "Mi equipo", "configPath": "../servicio/config.json" }
  ]
}
```

`configPath` se resuelve desde el directorio del archivo de conexiones. El servicio existente debe implementar la API de la consola Pi Durable v1 en `127.0.0.1` y conservar su `console-token` en su propio directorio de estado. Pulsa **Actualizar** en el panel. Los agentes externos aparecen con un ID como `external:equipo/revisor`. El panel lee su configuración y permite conversar cuando su servicio está activo. La edición de esos agentes corresponde a su servicio de origen. Para trabajar solo con servicios externos puedes omitir el paso 1.

### Qué se ha comprobado

| Requisito | Comprobación |
| --- | --- |
| Seleccionar al agente correcto | Dos agentes con el mismo nombre conservan IDs y chats independientes. Editar el nombre conserva el historial. |
| Reintentar después de perder la confirmación | La misma solicitud de alta o de mensaje puede repetirse sin crear un segundo agente ni duplicar el turno. |
| Recuperar el chat | Después de terminar el proceso con un mensaje ya admitido, abrir de nuevo SQLite permite completar el turno de demostración una sola vez. |
| Leer historiales extensos | El panel indica cuándo muestra una vista parcial y conserva los mensajes más recientes. El servicio propietario conserva el historial. |
| Conversar desde Orca | El recorrido de reclutar, enviar, editar y reabrir se comprueba en Orca Desktop para Windows. Las pruebas automatizadas de los adaptadores usan respuestas de prueba con el formato de cada proveedor. |

El diseño toma dos requisitos de `disler/durable-pi`. El servicio conserva la conversación al salir del cliente y reconoce la operación original cuando el cliente la reintenta. Su servidor `dpi-backend` usa una API por dispositivo y sesión. La conexión externa descrita arriba requiere las rutas de la consola local, como `/v1/agents/<id>/chat`. [API de la implementación de referencia](https://github.com/disler/durable-pi/blob/37165c619573dbaf425463038bbffecfe576beec/apps/dpi-backend/API.md)

## Almacenamiento y solución de problemas

- **El panel pide iniciar el servicio.** Ejecuta `npm start` desde `runtime/`, con el mismo usuario del sistema que ejecuta Orca. El puerto local es `127.0.0.1:47896`. Si ya hay una instancia activa, utiliza esa instancia.
- **Vas a cambiar de modelo o instrucciones.** Espera a que termine la respuesta actual y guarda los cambios. Los mensajes ya guardados conservan su contenido.
- **Se interrumpió el envío.** La acción de reintentar reutiliza el identificador del mensaje para que el servicio pueda reconocer un envío ya aceptado.
- **Quieres respaldar tus conversaciones.** Detén el servicio y copia el directorio `.pi-durable-orca` de tu carpeta de usuario. La base de datos es `agents.sqlite`. El descriptor de conexión contiene un token local y debe mantenerse privado. Los servicios externos conservan sus datos en sus propios directorios.
- **Quieres volver a la lista de agentes nativa.** Pi Durable funciona desde su propio panel en la barra lateral. El selector de agentes y el chat nativo pertenecen a Orca. [Extensiones admitidas por Orca](https://github.com/stablyai/orca/blob/v1.4.278/docs/reference/plugin-manifest.md)

## Desarrollar y verificar

Desde la raíz del repositorio, después de instalar las dependencias del servicio:

```sh
npm --prefix runtime test
node --test tests/*.test.mjs
orca plugin validate plugins/pi-durable
orca plugin check plugins/pi-durable
orca plugin validate orca-catalog.json
```

La regresión de la interfaz se ejecuta con `python tests/panel_browser.py` en un entorno de desarrollo con Python, Playwright y Chromium. Para usar Chrome instalado, establece `PLAYWRIGHT_CHANNEL=chrome`. La prueba reproduce en un navegador la pérdida de una confirmación de alta y la reapertura del panel, sin llamar a un proveedor.

Para trabajar con una copia local, ejecuta `orca plugin dev load plugins/pi-durable` y sigue la revisión de permisos que presenta Orca. El ID de desarrollo es `local.pi-durable`. El ID de catálogo es `gvillarroel.pi-durable`.

Cada plugin tiene su propio directorio dentro de `plugins/`. Para incorporar otro, crea su manifiesto en esa carpeta, valida los archivos y confirma el cambio en Git. Ejecuta `orca plugin release-entry plugins/<id>` y añade la entrada al catálogo raíz con su `source.path`, commit y hash. De ese modo, cada versión se instala y se actualiza de forma independiente. [Guía de publicación de Orca](https://github.com/stablyai/orca/blob/v1.4.278/docs/reference/plugin-authoring.md)

[Licencia MIT](LICENSE)
