<%@ WebHandler Language="VB" Class="HealthApi" %>
<%@ Assembly Name="System.Management, Version=4.0.0.0, Culture=neutral, PublicKeyToken=b03f5f7f11d50a3a" %>

Option Explicit On
Option Strict On
Option Infer Off

Imports System
Imports System.Collections.Generic
Imports System.Configuration
Imports System.Data.Common
Imports System.Diagnostics
Imports System.IO
Imports System.Management
Imports System.Web
Imports System.Web.Hosting
Imports System.Web.Script.Serialization

''' <summary>
''' Server health for the TimesGate controller's Servers plugin (or anything else that reads JSON).
'''   GET /health.ashx   with   Authorization: Bearer &lt;key&gt;   (or X-Api-Key: &lt;key&gt;)
''' The key is the HealthKey setting in web.config's appSettings. With no key set, the handler refuses
''' every request, so it can't be left open by accident.
''' Reports: the server's CPU, memory, disks and uptime, whether Windows wants a restart, this site's
''' worker process, and (optionally) a test connection to each database named in HealthDatabases.
''' Nothing can be changed through it, and it never reports paths, connection strings or users.
''' Works on .NET 4.0 and later, with no extra packages. Drop it into any ASP.NET site.
''' </summary>
Public Class HealthApi
	Implements IHttpHandler

	Private Const ApiVersion As Integer = 1
	Private Const CacheSeconds As Integer = 10        ' answers within this long reuse the last reading
	Private Shared ReadOnly Json As New JavaScriptSerializer()
	Private Shared ReadOnly Lock As New Object()
	Private Shared lastReading As Dictionary(Of String, Object) = Nothing
	Private Shared lastReadingAt As DateTime = DateTime.MinValue

	Public ReadOnly Property IsReusable() As Boolean Implements IHttpHandler.IsReusable
		Get
			Return True
		End Get
	End Property

	Public Sub ProcessRequest(ByVal context As HttpContext) Implements IHttpHandler.ProcessRequest
		Dim response As HttpResponse = context.Response
		response.ContentType = "application/json"
		response.Cache.SetCacheability(HttpCacheability.NoCache)
		response.Cache.SetNoStore()
		response.AppendHeader("X-Robots-Tag", "noindex")

		Try
			If context.Request.HttpMethod <> "GET" AndAlso context.Request.HttpMethod <> "HEAD" Then
				response.AppendHeader("Allow", "GET, HEAD")
				Fail(context, 405, "method_not_allowed", "This API is read-only: use GET.")
				Return
			End If
			If context.Request.QueryString("key") IsNot Nothing Then
				Fail(context, 400, "key_in_url", "Send the key in the Authorization header (Bearer), not in the URL.")
				Return
			End If

			Dim expected As String = ConfigurationManager.AppSettings("HealthKey")
			If String.IsNullOrEmpty(expected) OrElse expected.Trim().Length < 16 Then
				Fail(context, 503, "not_configured", "Set a HealthKey of at least 16 characters in web.config's appSettings.")
				Return
			End If
			Dim key As String = ReadKey(context.Request)
			If key Is Nothing OrElse Not SameKey(key, expected.Trim()) Then
				Unauthorized(context)
				Return
			End If

			response.Write(Json.Serialize(Reading()))
		Catch ex As Exception
			Fail(context, 500, "server_error", If(context.Request.IsLocal, "Server error: " & ex.Message, "Something went wrong."))
		End Try
	End Sub

	''' <summary>The latest reading, taken again if the last one is older than CacheSeconds.</summary>
	Public Shared Function Reading() As Dictionary(Of String, Object)
		SyncLock Lock
			If lastReading Is Nothing OrElse (DateTime.UtcNow - lastReadingAt).TotalSeconds >= CacheSeconds Then
				lastReading = Collect()
				lastReadingAt = DateTime.UtcNow
			End If
			Return lastReading
		End SyncLock
	End Function

	''' <summary>Everything reported. Each part is read separately, so one that fails (permissions) leaves the rest.</summary>
	Public Shared Function Collect() As Dictionary(Of String, Object)
		Dim result As New Dictionary(Of String, Object)()
		Dim problems As New List(Of String)()
		result("apiVersion") = ApiVersion
		result("generatedAt") = DateTime.UtcNow.ToString("yyyy-MM-ddTHH:mm:ssZ")
		result("server") = Environment.MachineName
		result("site") = If(HostingEnvironment.IsHosted, HostingEnvironment.SiteName, Nothing)
		result("dotnet") = Environment.Version.ToString()

		' CPU, memory and uptime, from WMI.
		Try
			Dim cpuTotal As Integer = 0, cpuCount As Integer = 0
			Using searcher As New ManagementObjectSearcher("SELECT LoadPercentage FROM Win32_Processor")
				For Each item As ManagementBaseObject In searcher.Get()
					If item("LoadPercentage") IsNot Nothing Then
						cpuTotal += Convert.ToInt32(item("LoadPercentage"))
						cpuCount += 1
					End If
				Next
			End Using
			result("cpuPercent") = If(cpuCount > 0, CObj(CInt(Math.Round(cpuTotal / cpuCount))), Nothing)
			result("cores") = Environment.ProcessorCount
		Catch ex As Exception
			result("cpuPercent") = Nothing
			problems.Add("cpu: " & ex.Message)
		End Try
		Try
			Using searcher As New ManagementObjectSearcher("SELECT Caption, Version, TotalVisibleMemorySize, FreePhysicalMemory, LastBootUpTime FROM Win32_OperatingSystem")
				For Each item As ManagementBaseObject In searcher.Get()
					result("os") = (Convert.ToString(item("Caption")) & " " & Convert.ToString(item("Version"))).Trim()
					Dim totalKb As Long = Convert.ToInt64(item("TotalVisibleMemorySize"))
					Dim freeKb As Long = Convert.ToInt64(item("FreePhysicalMemory"))
					Dim memory As New Dictionary(Of String, Object)()
					memory("totalMb") = totalKb \ 1024
					memory("usedMb") = (totalKb - freeKb) \ 1024
					memory("percent") = If(totalKb > 0, CInt(Math.Round(100.0 * (totalKb - freeKb) / totalKb)), 0)
					result("memory") = memory
					Dim boot As DateTime = ManagementDateTimeConverter.ToDateTime(Convert.ToString(item("LastBootUpTime")))
					result("uptimeSeconds") = CLng((DateTime.Now - boot).TotalSeconds)
					result("bootedAt") = boot.ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
				Next
			End Using
		Catch ex As Exception
			result("memory") = Nothing
			result("uptimeSeconds") = Nothing
			problems.Add("memory: " & ex.Message)
		End Try

		' Fixed disks: size and free space, by drive letter.
		Dim disks As New List(Of Dictionary(Of String, Object))()
		Try
			For Each drive As DriveInfo In DriveInfo.GetDrives()
				If drive.DriveType <> DriveType.Fixed OrElse Not drive.IsReady Then Continue For
				Dim disk As New Dictionary(Of String, Object)()
				disk("name") = drive.Name.TrimEnd("\"c)
				disk("label") = drive.VolumeLabel
				disk("totalGb") = Math.Round(drive.TotalSize / 1073741824.0, 1)
				disk("freeGb") = Math.Round(drive.AvailableFreeSpace / 1073741824.0, 1)
				disk("percentUsed") = If(drive.TotalSize > 0, CInt(Math.Round(100.0 * (drive.TotalSize - drive.AvailableFreeSpace) / drive.TotalSize)), 0)
				disks.Add(disk)
			Next
		Catch ex As Exception
			problems.Add("disks: " & ex.Message)
		End Try
		result("disks") = disks

		' Windows has installed updates and is waiting to restart.
		Try
			Dim pending As Boolean = False
			For Each path As String In New String() {
				"SOFTWARE\Microsoft\Windows\CurrentVersion\WindowsUpdate\Auto Update\RebootRequired",
				"SOFTWARE\Microsoft\Windows\CurrentVersion\Component Based Servicing\RebootPending"}
				Using k As Microsoft.Win32.RegistryKey = Microsoft.Win32.Registry.LocalMachine.OpenSubKey(path)
					If k IsNot Nothing Then pending = True
				End Using
			Next
			result("restartPending") = pending
		Catch ex As Exception
			result("restartPending") = Nothing
		End Try

		' This site's worker process (w3wp): how long it has run and how much memory it uses.
		Try
			Using p As Process = Process.GetCurrentProcess()
				Dim app As New Dictionary(Of String, Object)()
				app("startedAt") = p.StartTime.ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
				app("memoryMb") = p.WorkingSet64 \ 1048576
				app("threads") = p.Threads.Count
				result("app") = app
			End Using
		Catch ex As Exception
			result("app") = Nothing
		End Try

		' Databases: a test connection to each connection string named in HealthDatabases (comma-separated).
		Dim databases As New List(Of Dictionary(Of String, Object))()
		Dim names As String = ConfigurationManager.AppSettings("HealthDatabases")
		If Not String.IsNullOrEmpty(names) Then
			For Each raw As String In names.Split(","c)
				Dim name As String = raw.Trim()
				If name.Length = 0 Then Continue For
				databases.Add(TestDatabase(name))
			Next
		End If
		result("databases") = databases

		result("readErrors") = problems   ' parts that couldn't be read (usually the app pool's permissions)
		Return result
	End Function

	''' <summary>Opens the named connection and runs SELECT 1, timing it. Only the name and the outcome are reported.</summary>
	Private Shared Function TestDatabase(ByVal name As String) As Dictionary(Of String, Object)
		Dim db As New Dictionary(Of String, Object)()
		db("name") = name
		Dim settings As ConnectionStringSettings = ConfigurationManager.ConnectionStrings(name)
		If settings Is Nothing Then
			db("ok") = False
			db("error") = "No connection string with that name"
			Return db
		End If
		Dim watch As Stopwatch = Stopwatch.StartNew()
		Try
			Dim provider As String = If(String.IsNullOrEmpty(settings.ProviderName), "System.Data.SqlClient", settings.ProviderName)
			Dim factory As DbProviderFactory = DbProviderFactories.GetFactory(provider)
			Using connection As DbConnection = factory.CreateConnection()
				connection.ConnectionString = settings.ConnectionString
				connection.Open()
				Using command As DbCommand = connection.CreateCommand()
					command.CommandText = "SELECT 1"
					command.CommandTimeout = 5
					command.ExecuteScalar()
				End Using
			End Using
			db("ok") = True
		Catch ex As Exception
			db("ok") = False
			db("error") = ex.GetType().Name   ' (the type only: messages can include server names)
		End Try
		db("ms") = CInt(watch.ElapsedMilliseconds)
		Return db
	End Function

	''' <summary>The key from "Authorization: Bearer ..." or "X-Api-Key", or Nothing.</summary>
	Private Shared Function ReadKey(ByVal request As HttpRequest) As String
		Dim auth As String = request.Headers("Authorization")
		If Not String.IsNullOrEmpty(auth) AndAlso auth.StartsWith("Bearer ", StringComparison.OrdinalIgnoreCase) Then
			Dim value As String = auth.Substring(7).Trim()
			If value.Length > 0 Then Return value
		End If
		Dim header As String = request.Headers("X-Api-Key")
		If Not String.IsNullOrEmpty(header) AndAlso header.Trim().Length > 0 Then Return header.Trim()
		Return Nothing
	End Function

	''' <summary>Compares in constant time, so the key can't be guessed from how long a refusal takes.</summary>
	Private Shared Function SameKey(ByVal a As String, ByVal b As String) As Boolean
		If a.Length <> b.Length Then Return False
		Dim diff As Integer = 0
		For i As Integer = 0 To a.Length - 1
			diff = diff Or (AscW(a(i)) Xor AscW(b(i)))
		Next
		Return diff = 0
	End Function

	Private Shared Sub Unauthorized(ByVal context As HttpContext)
		' Stop forms authentication turning the 401 into a redirect to a login page (.NET 4.5+, set by reflection).
		Dim suppress As System.Reflection.PropertyInfo = GetType(HttpResponse).GetProperty("SuppressFormsAuthenticationRedirect")
		If suppress IsNot Nothing Then suppress.SetValue(context.Response, True, Nothing)
		context.Response.AppendHeader("WWW-Authenticate", "Bearer")
		Fail(context, 401, "invalid_key", "Send the health key in the Authorization header: ""Authorization: Bearer <key>"".")
	End Sub

	Private Shared Sub Fail(ByVal context As HttpContext, ByVal statusCode As Integer, ByVal code As String, ByVal message As String)
		context.Response.StatusCode = statusCode
		context.Response.TrySkipIisCustomErrors = True
		Dim body As New Dictionary(Of String, Object)()
		body("error") = code
		body("message") = message
		context.Response.Write(Json.Serialize(body))
	End Sub

End Class
