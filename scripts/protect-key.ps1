param([Parameter(Mandatory)][ValidateSet('Protect', 'Unprotect')][string]$Operation)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
[byte[]]$bytes = [Convert]::FromBase64String([Console]::In.ReadToEnd().Trim())
$scope = [System.Security.Cryptography.DataProtectionScope]::CurrentUser
if ($Operation -eq 'Protect') {
    $bytes = [System.Security.Cryptography.ProtectedData]::Protect($bytes, $null, $scope)
} else {
    $bytes = [System.Security.Cryptography.ProtectedData]::Unprotect($bytes, $null, $scope)
}
[Console]::Out.Write([Convert]::ToBase64String($bytes))
