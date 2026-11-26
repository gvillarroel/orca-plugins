# Orca Plugins

**Pi Durable** añade un listado de agentes en inglés a Orca. Al seleccionar un agente local se abre **Pi Chat** en una pestaña central del workspace. **Details** muestra el historial guardado en SQLite y **Edit** permite cambiar las instrucciones, el nombre y el modelo conservando el identificador. [Guía completa de Pi Durable e instalación en inglés](plugins/pi-durable/README.md)

## Instalar Pi Durable

La integración se probó con Orca Desktop 1.4.278 para Windows, Node.js 24 y Pi Coding Agent 1.4.0. Necesitas también npm y Git.

1. Si aún no tienes Pi, ejecuta `npm install -g @earendil-works/pi-coding-agent@1.4.0`. Comprueba que Pi aparece en **Settings → Agents** de Orca.
2. Descarga la versión, registra el proveedor local en Pi e inicia el servicio.

   ```sh
   git clone --branch pi-durable-v0.2.0 https://github.com/gvillarroel/orca-plugins.git
   cd orca-plugins
   pi install ./integrations/pi-durable-provider
   cd runtime
   npm ci
   npm start
   ```

   Conserva la carpeta en esa ubicación y deja el servicio en ejecución mientras usas tus agentes.

3. Añade el catálogo `https://github.com/gvillarroel/orca-plugins.git`, ref `main`, en **Settings → Plugins**. Instala **Pi Durable** y revisa los permisos de Orca.
4. Abre un workspace local y selecciona **Pi Durable → + Recruit** en la barra derecha. Escribe un nombre y elige `demo`. Al guardar, escribe un mensaje en la pestaña central. El modelo de demostración devuelve un eco local.

Si usas una versión anterior, actualiza el servicio, el proveedor de Pi y el plugin de Orca siguiendo la guía. Se reutiliza la base de datos de tu usuario. [Actualizar desde 0.1.x](plugins/pi-durable/README.md#upgrade-from-01x)

En una pestaña nativa puedes mencionar archivos con `@`. Con un perfil que admite herramientas, Pi puede leer un archivo del workspace y Orca muestra la operación junto a la respuesta. [Captura de la lectura en Orca](docs/pi-durable/native-tool.png)

Cada plugin se distribuye desde su carpeta en `plugins/`; el catálogo raíz fija la versión, el commit y el hash de cada publicación. [Catálogo](orca-catalog.json) · [Licencia MIT](LICENSE)
