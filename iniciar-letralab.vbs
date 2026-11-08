' Arranca el servidor de LetraLab en segundo plano, sin ventana.
' Windows lo ejecuta al iniciar sesión (acceso directo en la carpeta Inicio).
' Si el servidor ya está corriendo, el segundo intento se cierra solo (puerto ocupado).
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = dir
If Not fso.FolderExists(dir & "\data") Then fso.CreateFolder(dir & "\data")
sh.Run "cmd /c """"C:\Program Files\nodejs\node.exe"" server.js >> data\server.log 2>&1""", 0, False
