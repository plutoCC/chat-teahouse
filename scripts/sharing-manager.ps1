param(
  [string]$PreviewPath
)

# This is a local desktop window. It does not listen on a network port.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName PresentationFramework, PresentationCore, WindowsBase

$script:TeaRoot = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$script:TeaBackend = Join-Path $PSScriptRoot 'sharing-manager.ts'
$script:TeaNode = $null
$script:TeaOperation = $null
$script:TeaStatus = $null
$script:TeaInvitation = $null
$script:TeaClosing = $false
$script:TeaLastRefresh = [DateTime]::MinValue
$script:TeaControls = @{}
$script:TeaAvailable = $false
$script:TeaNoticeAfterRefresh = $null
$script:TeaApplyingStatus = $false
$script:TeaSelectedAccountId = $null
$script:TeaPendingAccountId = $null
$script:TeaSettings = $null
$script:TeaSettingsFields = @{}
$script:TeaSettingsDirty = $false
$script:TeaApplyingSettings = $false

[xml]$teaXaml = @'
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
        Title="茶馆分享助手" Width="1040" Height="850" MinWidth="940" MinHeight="740"
        WindowStartupLocation="CenterScreen" Background="#F4F5EF" FontFamily="Microsoft YaHei UI, Microsoft YaHei, Segoe UI"
        FontSize="13" Foreground="#233D34" UseLayoutRounding="True">
  <Window.Resources>
    <Style TargetType="Button">
      <Setter Property="Padding" Value="15,10"/><Setter Property="Margin" Value="0,0,8,0"/>
      <Setter Property="Background" Value="#FFFFFF"/><Setter Property="Foreground" Value="#315749"/>
      <Setter Property="BorderBrush" Value="#D6E1D8"/><Setter Property="BorderThickness" Value="1"/>
      <Setter Property="FontSize" Value="13"/><Setter Property="Cursor" Value="Hand"/>
      <Setter Property="HorizontalContentAlignment" Value="Center"/>
      <Setter Property="Template"><Setter.Value>
        <ControlTemplate TargetType="Button">
          <Border x:Name="ButtonBorder" Background="{TemplateBinding Background}" BorderBrush="{TemplateBinding BorderBrush}" BorderThickness="{TemplateBinding BorderThickness}" CornerRadius="8" Padding="{TemplateBinding Padding}">
            <ContentPresenter HorizontalAlignment="{TemplateBinding HorizontalContentAlignment}" VerticalAlignment="Center"/>
          </Border>
          <ControlTemplate.Triggers>
            <Trigger Property="IsMouseOver" Value="True"><Setter TargetName="ButtonBorder" Property="Opacity" Value="0.82"/></Trigger>
            <Trigger Property="IsPressed" Value="True"><Setter TargetName="ButtonBorder" Property="Opacity" Value="0.65"/></Trigger>
            <Trigger Property="IsEnabled" Value="False"><Setter TargetName="ButtonBorder" Property="Opacity" Value="0.42"/><Setter Property="Cursor" Value="Arrow"/></Trigger>
            <Trigger Property="IsKeyboardFocused" Value="True"><Setter TargetName="ButtonBorder" Property="BorderBrush" Value="#267A5F"/><Setter TargetName="ButtonBorder" Property="BorderThickness" Value="2"/></Trigger>
          </ControlTemplate.Triggers>
        </ControlTemplate>
      </Setter.Value></Setter>
    </Style>
    <Style x:Key="PrimaryButton" TargetType="Button" BasedOn="{StaticResource {x:Type Button}}">
      <Setter Property="Background" Value="#2D7058"/><Setter Property="Foreground" Value="White"/><Setter Property="BorderBrush" Value="#2D7058"/>
    </Style>
    <Style x:Key="DangerButton" TargetType="Button" BasedOn="{StaticResource {x:Type Button}}">
      <Setter Property="Foreground" Value="#9B4C3C"/><Setter Property="BorderBrush" Value="#E8D6CE"/><Setter Property="Background" Value="#FFFDFC"/>
    </Style>
    <Style TargetType="TextBox">
      <Setter Property="Padding" Value="11,10"/><Setter Property="BorderBrush" Value="#D7E0D8"/><Setter Property="BorderThickness" Value="1"/>
      <Setter Property="Background" Value="#FBFCF9"/><Setter Property="Foreground" Value="#284238"/>
      <Setter Property="VerticalContentAlignment" Value="Center"/>
    </Style>
    <Style x:Key="Muted" TargetType="TextBlock"><Setter Property="Foreground" Value="#708177"/><Setter Property="TextWrapping" Value="Wrap"/><Setter Property="LineHeight" Value="21"/></Style>
    <Style x:Key="Card" TargetType="Border"><Setter Property="Background" Value="White"/><Setter Property="CornerRadius" Value="14"/><Setter Property="Padding" Value="22"/><Setter Property="BorderBrush" Value="#E1E7DE"/><Setter Property="BorderThickness" Value="1"/></Style>
    <Style TargetType="ListBoxItem">
      <Setter Property="Padding" Value="12,10"/><Setter Property="HorizontalContentAlignment" Value="Stretch"/>
      <Setter Property="Margin" Value="0,0,0,4"/>
      <Setter Property="Template"><Setter.Value><ControlTemplate TargetType="ListBoxItem">
        <Border x:Name="ItemBorder" Background="Transparent" CornerRadius="8" Padding="{TemplateBinding Padding}"><ContentPresenter/></Border>
        <ControlTemplate.Triggers><Trigger Property="IsSelected" Value="True"><Setter TargetName="ItemBorder" Property="Background" Value="#EAF2EB"/></Trigger><Trigger Property="IsMouseOver" Value="True"><Setter TargetName="ItemBorder" Property="Background" Value="#F0F5EF"/></Trigger></ControlTemplate.Triggers>
      </ControlTemplate></Setter.Value></Setter>
    </Style>
  </Window.Resources>
  <Grid x:Name="RootView" Background="#F4F5EF">
    <Grid.ColumnDefinitions><ColumnDefinition Width="188"/><ColumnDefinition Width="*"/></Grid.ColumnDefinitions>
    <Border Grid.Column="0" Background="#234C3C" Padding="23,30,20,24">
      <DockPanel LastChildFill="True">
        <StackPanel DockPanel.Dock="Top">
          <Border Background="#426957" CornerRadius="12" Width="48" Height="48" HorizontalAlignment="Left" Margin="0,0,0,15"><TextBlock Text="茶" Foreground="#F5F2DA" FontSize="26" VerticalAlignment="Center" HorizontalAlignment="Center"/></Border>
          <TextBlock Text="茶馆" FontSize="25" FontWeight="SemiBold" Foreground="White"/>
          <TextBlock Text="分享助手" FontSize="15" Foreground="#C7D9CD" Margin="0,5,0,30"/>
          <Button x:Name="SiteNavButton" Content="网站与邀请" Background="#355F4C" Foreground="White" BorderThickness="0" Margin="0,0,0,8" HorizontalContentAlignment="Left"/>
          <Button x:Name="SettingsNavButton" Content="额度与限制" Background="#355F4C" Foreground="White" BorderThickness="0" Margin="0" HorizontalContentAlignment="Left"/>
          <TextBlock Text="三步邀请朋友" Foreground="#B5CFBC" FontSize="11" Margin="0,30,0,14"/>
          <TextBlock Text="01   启动网站" Foreground="#E7EFE6" Margin="0,0,0,16"/>
          <TextBlock Text="02   开启公开分享" Foreground="#E7EFE6" Margin="0,0,0,16"/>
          <TextBlock Text="03   创建专属邀请" Foreground="#E7EFE6"/>
        </StackPanel>
        <StackPanel DockPanel.Dock="Bottom" VerticalAlignment="Bottom">
          <Border Height="1" Background="#52735E" Margin="0,24,0,18"/>
          <TextBlock Text="你的电脑 · 你的茶馆" Foreground="#E0EADA" FontSize="12" Margin="0,0,0,8"/>
          <TextBlock Text="关闭这个窗口，网站会继续运行。" Foreground="#B5CFBC" FontSize="12" TextWrapping="Wrap" LineHeight="20"/>
        </StackPanel>
      </DockPanel>
    </Border>
    <ScrollViewer x:Name="SitePage" Grid.Column="1" VerticalScrollBarVisibility="Auto" HorizontalScrollBarVisibility="Disabled">
      <StackPanel Margin="28,26,28,24">
        <Grid Margin="0,0,0,19"><Grid.ColumnDefinitions><ColumnDefinition Width="*"/><ColumnDefinition Width="Auto"/></Grid.ColumnDefinitions>
          <StackPanel><TextBlock Text="把茶馆分享给朋友" FontSize="23" FontWeight="SemiBold"/><TextBlock Text="不用输入命令，在这里管理网站、分享链接和邀请。" Style="{StaticResource Muted}" Margin="0,7,0,0"/></StackPanel>
          <Button x:Name="RefreshButton" Grid.Column="1" Content="刷新状态" VerticalAlignment="Top" Margin="15,3,0,0" ToolTip="重新检查这台电脑上的网站和 Tailscale 分享状态"/>
        </Grid>
        <Border x:Name="NoticeBorder" CornerRadius="9" Background="#EAF1E7" Padding="13,10" Margin="0,0,0,15">
          <TextBlock x:Name="NoticeText" Text="正在读取状态…" TextWrapping="Wrap" Foreground="#3B644E" LineHeight="20"/>
        </Border>
        <Grid Margin="0,0,0,16"><Grid.ColumnDefinitions><ColumnDefinition Width="*"/><ColumnDefinition Width="16"/><ColumnDefinition Width="*"/></Grid.ColumnDefinitions>
          <Border Style="{StaticResource Card}" Padding="19">
            <StackPanel><Grid><TextBlock Text="01  网站服务" FontSize="15" FontWeight="SemiBold"/>
              <Border x:Name="AppBadge" Background="#F0F2ED" CornerRadius="10" Padding="9,3" HorizontalAlignment="Right"><TextBlock x:Name="AppState" Text="检查中" FontSize="11" Foreground="#6F7F73"/></Border></Grid>
              <TextBlock x:Name="AppDetail" Text="准备检查本机网站" Style="{StaticResource Muted}" Margin="0,12,0,14" MinHeight="42"/>
              <WrapPanel><Button x:Name="StartButton" Content="启动网站" Style="{StaticResource PrimaryButton}"/><Button x:Name="StopButton" Content="停止" Style="{StaticResource DangerButton}" Margin="0"/></WrapPanel>
            </StackPanel>
          </Border>
          <Border Grid.Column="2" Style="{StaticResource Card}" Padding="19">
            <StackPanel><Grid><TextBlock Text="02  公开分享" FontSize="15" FontWeight="SemiBold"/>
              <Border x:Name="ShareBadge" Background="#F0F2ED" CornerRadius="10" Padding="9,3" HorizontalAlignment="Right"><TextBlock x:Name="ShareState" Text="检查中" FontSize="11" Foreground="#6F7F73"/></Border></Grid>
              <TextBlock x:Name="ShareDetail" Text="准备检查 Tailscale 连接" Style="{StaticResource Muted}" Margin="0,12,0,14" MinHeight="42"/>
              <WrapPanel><Button x:Name="ShareStartButton" Content="开启分享" Style="{StaticResource PrimaryButton}"/><Button x:Name="ShareStopButton" Content="关闭分享" Style="{StaticResource DangerButton}" Margin="0"/></WrapPanel>
            </StackPanel>
          </Border>
        </Grid>
        <Border Style="{StaticResource Card}" Padding="20,17" Margin="0,0,0,16">
          <StackPanel><TextBlock Text="分享网址" FontWeight="SemiBold" Margin="0,0,0,9"/>
            <TextBox x:Name="UrlText" IsReadOnly="True" Text="读取中…" FontSize="13" ToolTip="此网址不包含访问码；朋友仍然需要专属访问码才能登录"/>
            <Grid Margin="0,11,0,0"><Grid.ColumnDefinitions><ColumnDefinition Width="*"/><ColumnDefinition Width="Auto"/></Grid.ColumnDefinitions>
              <WrapPanel><Button x:Name="OpenButton" Content="打开网站"/><Button x:Name="CopyUrlButton" Content="复制网址"/></WrapPanel>
              <Button x:Name="AdminButton" Grid.Column="1" Content="本机模型设置 ↗" BorderThickness="0" Background="Transparent" Margin="0" Padding="7,10" ToolTip="只在本机打开模型管理页面，不会公开管理后台"/>
            </Grid>
          </StackPanel>
        </Border>
        <Border Style="{StaticResource Card}" Padding="20" Margin="0,0,0,16">
          <StackPanel><Grid Margin="0,0,0,14"><TextBlock Text="03  邀请朋友" FontSize="16" FontWeight="SemiBold"/><TextBlock x:Name="AccountCount" HorizontalAlignment="Right" Foreground="#708177" VerticalAlignment="Center"/></Grid>
            <TextBlock Text="一位朋友一个访问码，聊天和笔记各自独立；共享 AI 形象和你提供的 API 额度。个人 ChatGPT 订阅不在此共享。" Style="{StaticResource Muted}" Margin="0,0,0,17"/>
            <TextBlock x:Name="AccountsError" Visibility="Collapsed" TextWrapping="Wrap" Foreground="#95533D" LineHeight="20" Margin="0,0,0,14"/>
            <Grid><Grid.ColumnDefinitions><ColumnDefinition Width="*"/><ColumnDefinition Width="22"/><ColumnDefinition Width="*"/></Grid.ColumnDefinitions>
              <StackPanel>
                <TextBlock Text="已邀请的朋友" FontWeight="SemiBold" Margin="0,0,0,8"/>
                <Grid Height="174"><Border BorderBrush="#E0E7DE" BorderThickness="1" CornerRadius="8" Background="#FBFCFA"/>
                  <ListBox x:Name="AccountList" Margin="4" BorderThickness="0" Background="Transparent" ScrollViewer.HorizontalScrollBarVisibility="Disabled" SelectedValuePath="id">
                    <ListBox.ItemTemplate><DataTemplate><Grid><Grid.ColumnDefinitions><ColumnDefinition Width="*"/><ColumnDefinition Width="Auto"/></Grid.ColumnDefinitions><StackPanel><TextBlock Text="{Binding name}" FontWeight="SemiBold" TextTrimming="CharacterEllipsis"/><TextBlock Text="{Binding dateLabel}" Foreground="#819084" FontSize="11" Margin="0,4,0,0"/></StackPanel><TextBlock Grid.Column="1" Text="可访问" Foreground="#45805B" FontSize="11" VerticalAlignment="Center" Margin="10,0,0,0"/></Grid></DataTemplate></ListBox.ItemTemplate>
                  </ListBox>
                  <TextBlock x:Name="EmptyAccounts" Text="还没有邀请朋友" Foreground="#8A988B" VerticalAlignment="Center" HorizontalAlignment="Center" IsHitTestVisible="False"/>
                </Grid>
                <Button x:Name="RevokeButton" Content="撤销所选朋友的访问" Style="{StaticResource DangerButton}" HorizontalAlignment="Left" Margin="0,10,0,0" Padding="12,8"/>
                <TextBlock x:Name="RevokedCount" Foreground="#8A958A" FontSize="11" Margin="0,8,0,0"/>
              </StackPanel>
              <StackPanel Grid.Column="2">
                <TextBlock Text="创建专属邀请" FontWeight="SemiBold" Margin="0,0,0,8"/>
                <TextBox x:Name="FriendName" MaxLength="50" AutomationProperties.Name="朋友的名字" ToolTip="填写便于你识别的名字，例如：小林"/>
                <TextBlock Text="填写朋友的名字，例如：小林" Style="{StaticResource Muted}" FontSize="11" Margin="0,5,0,10"/>
                <Button x:Name="InviteButton" Content="创建邀请" Style="{StaticResource PrimaryButton}" HorizontalAlignment="Left" Margin="0"/>
                <TextBlock Text="选中已邀请的朋友，即可随时查看和复制访问码。访问码会加密保存在本机。" Style="{StaticResource Muted}" FontSize="12" Margin="0,13,0,0"/>
              </StackPanel>
            </Grid>
            <Border x:Name="InvitationPanel" Visibility="Collapsed" Background="#F1F6EB" BorderBrush="#D5E2C9" BorderThickness="1" CornerRadius="10" Padding="15" Margin="0,18,0,0">
              <StackPanel><TextBlock x:Name="InvitationTitle" FontWeight="SemiBold" FontSize="14"/><TextBlock x:Name="InvitationHint" Text="只有这台电脑上的分享助手可以查看访问码，请私下发给对应的朋友。" Style="{StaticResource Muted}" FontSize="12" Margin="0,6,0,10"/>
                <TextBox x:Name="InvitationCode" IsReadOnly="True" FontFamily="Consolas" Background="White" FontSize="12"/>
                <WrapPanel Margin="0,11,0,0"><Button x:Name="CopyInviteButton" Content="复制完整邀请" Style="{StaticResource PrimaryButton}" Padding="12,8"/><Button x:Name="CopyCodeButton" Content="只复制访问码" Padding="12,8"/><Button x:Name="ResetCodeButton" Content="重置访问码" Style="{StaticResource DangerButton}" Padding="12,8" Margin="0"/></WrapPanel>
                <StackPanel x:Name="LegacyCodePanel" Visibility="Collapsed" Margin="0,14,0,0">
                  <TextBlock Text="旧版仅保存校验值，无法还原访问码。你可以粘贴原码保存；若已遗失，请点击“重置访问码”。" Style="{StaticResource Muted}" Margin="0,0,0,8"/>
                  <TextBox x:Name="LegacyCodeInput" MaxLength="128" AutomationProperties.Name="已有访问码" ToolTip="粘贴之前发给这位朋友的原访问码"/>
                  <Button x:Name="ImportCodeButton" Content="保存原访问码" HorizontalAlignment="Left" Padding="12,8" Margin="0,9,0,0"/>
                </StackPanel>
              </StackPanel>
            </Border>
          </StackPanel>
        </Border>
        <Border Background="#EBEFE5" CornerRadius="11" Padding="18,14">
          <StackPanel><TextBlock x:Name="QuotaText" Text="正在读取额度保护设置…" FontWeight="SemiBold" TextWrapping="Wrap"/>
            <TextBlock x:Name="UsageText" Text="" Style="{StaticResource Muted}" FontSize="12" Margin="0,7,0,0"/>
            <TextBlock Text="分享期间，电脑需保持开机、联网且不休眠。关闭分享只会切断外网访问；停止网站会中断当前请求。" Style="{StaticResource Muted}" FontSize="12" Margin="0,7,0,0"/>
          </StackPanel>
        </Border>
        <TextBlock x:Name="UpdatedText" Text="" Foreground="#899588" FontSize="11" Margin="0,12,0,0" HorizontalAlignment="Right"/>
      </StackPanel>
    </ScrollViewer>
    <ScrollViewer x:Name="SettingsPage" Grid.Column="1" Visibility="Collapsed" VerticalScrollBarVisibility="Auto" HorizontalScrollBarVisibility="Disabled">
      <StackPanel Margin="28,26,28,24">
        <TextBlock Text="额度与使用限制" FontSize="23" FontWeight="SemiBold"/>
        <TextBlock Text="按你的预算和使用人数调整。保存后立即生效，无需重启网站；不会删除已有聊天和成员。" Style="{StaticResource Muted}" Margin="0,8,0,16"/>
        <Border Background="#EAF1E7" CornerRadius="9" Padding="13,10" Margin="0,0,0,16"><TextBlock x:Name="SettingsState" Text="正在读取设置…" TextWrapping="Wrap" LineHeight="20"/></Border>
        <WrapPanel Margin="0,0,0,16"><Button x:Name="SaveSettingsTopButton" Content="保存设置" Style="{StaticResource PrimaryButton}"/><Button x:Name="ReloadSettingsTopButton" Content="放弃修改，重新读取" Margin="0"/></WrapPanel>
        <StackPanel x:Name="SettingsFieldsPanel"/>
        <Border Background="White" CornerRadius="12" Padding="18" Margin="0,4,0,0"><StackPanel>
          <WrapPanel><Button x:Name="SaveSettingsButton" Content="保存设置" Style="{StaticResource PrimaryButton}"/><Button x:Name="ReloadSettingsButton" Content="放弃修改，重新读取" Margin="0"/></WrapPanel>
          <TextBlock Text="金额是按已填写的模型单价估算的费用保护，不是服务商账单。每人上限作用于每位朋友自己的账号；所有账号同时受全站上限约束。" Style="{StaticResource Muted}" FontSize="12" Margin="0,12,0,0"/>
        </StackPanel></Border>
      </StackPanel>
    </ScrollViewer>
  </Grid>
</Window>
'@

$teaReader = [Xml.XmlNodeReader]::new($teaXaml)
try { $script:TeaWindow = [Windows.Markup.XamlReader]::Load($teaReader) }
finally { $teaReader.Close() }
@('RefreshButton','NoticeBorder','NoticeText','AppBadge','AppState','AppDetail','ShareBadge','ShareState','ShareDetail',
  'StartButton','StopButton','ShareStartButton','ShareStopButton','UrlText','OpenButton','CopyUrlButton','AdminButton',
  'AccountCount','AccountList','EmptyAccounts','AccountsError','RevokeButton','RevokedCount','FriendName','InviteButton','InvitationPanel',
  'InvitationTitle','InvitationHint','InvitationCode','CopyInviteButton','CopyCodeButton','ResetCodeButton','LegacyCodePanel','LegacyCodeInput','ImportCodeButton',
  'SiteNavButton','SettingsNavButton','SitePage','SettingsPage','SettingsFieldsPanel','SettingsState','SaveSettingsButton','ReloadSettingsButton',
  'SaveSettingsTopButton','ReloadSettingsTopButton','QuotaText','UsageText','UpdatedText','RootView') | ForEach-Object {
  $script:TeaControls[$_] = $script:TeaWindow.FindName($_)
}

function Set-TeaNotice([string]$Message, [switch]$Problem) {
  $script:TeaControls.NoticeText.Text = $Message
  $script:TeaControls.NoticeBorder.Background = if ($Problem) { '#FFF0E8' } else { '#EAF1E7' }
  $script:TeaControls.NoticeText.Foreground = if ($Problem) { '#95533D' } else { '#3B644E' }
}

function Get-TeaSafeUrl([string]$Value, [switch]$Admin) {
  $teaUri = $null
  if (-not [Uri]::TryCreate($Value, [UriKind]::Absolute, [ref]$teaUri)) { return $null }
  if ($teaUri.UserInfo -or $teaUri.Query -or $teaUri.Fragment -or $teaUri.AbsolutePath -ne '/') { return $null }
  if ($Admin) {
    if ($teaUri.Scheme -ne 'http' -or $teaUri.Host -ne '127.0.0.1' -or $teaUri.Port -lt 1024 -or $teaUri.Port -eq 4317) { return $null }
  } elseif ($teaUri.Scheme -ne 'https' -or $teaUri.HostNameType -ne [UriHostNameType]::Dns -or $teaUri.Host -notlike '*.ts.net') { return $null }
  return $teaUri.AbsoluteUri
}

function Update-TeaButtons {
  $teaFree = $script:TeaAvailable -and -not $script:TeaOperation
  $teaConfigured = $script:TeaStatus -and $script:TeaStatus.configured
  $teaAccountsReady = $teaConfigured -and -not $script:TeaStatus.accountsError
  $teaRunning = $teaConfigured -and $script:TeaStatus.app.state -eq 'running'
  $teaShareOn = $teaConfigured -and $script:TeaStatus.funnel.state -eq 'enabled'
  $teaShareOff = $teaConfigured -and $script:TeaStatus.funnel.state -eq 'disabled'
  $teaUrl = if ($script:TeaStatus) { Get-TeaSafeUrl $script:TeaStatus.publicOrigin } else { $null }
  $teaAdmin = if ($script:TeaStatus) { Get-TeaSafeUrl $script:TeaStatus.adminUrl -Admin } else { $null }
  $script:TeaControls.RefreshButton.IsEnabled = $teaFree
  $script:TeaControls.StartButton.IsEnabled = $teaFree -and $teaConfigured -and $script:TeaStatus.app.state -eq 'stopped'
  $script:TeaControls.StopButton.IsEnabled = $teaFree -and $teaRunning
  $script:TeaControls.ShareStartButton.IsEnabled = $teaFree -and $teaRunning -and $teaShareOff
  $script:TeaControls.ShareStopButton.IsEnabled = $teaFree -and $teaShareOn
  $script:TeaControls.OpenButton.IsEnabled = [bool]($teaUrl -and $teaRunning -and $teaShareOn)
  $script:TeaControls.CopyUrlButton.IsEnabled = [bool]$teaUrl
  $script:TeaControls.AdminButton.IsEnabled = [bool]($teaAdmin -and $teaRunning)
  $script:TeaControls.InviteButton.IsEnabled = $teaFree -and $teaAccountsReady -and -not [string]::IsNullOrWhiteSpace($script:TeaControls.FriendName.Text)
  $script:TeaControls.RevokeButton.IsEnabled = [bool]($teaFree -and $teaAccountsReady -and $script:TeaControls.AccountList.SelectedItem)
  $script:TeaControls.FriendName.IsEnabled = [bool]($teaFree -and $teaAccountsReady)
  $teaSelected = $script:TeaControls.AccountList.SelectedItem
  $teaHasCode = $script:TeaInvitation -and $teaSelected -and $script:TeaInvitation.Id -eq $teaSelected.id -and $script:TeaInvitation.Code
  $script:TeaControls.CopyInviteButton.IsEnabled = [bool]($teaHasCode -and $teaUrl)
  $script:TeaControls.CopyCodeButton.IsEnabled = [bool]$teaHasCode
  $script:TeaControls.ResetCodeButton.IsEnabled = [bool]($teaFree -and $teaAccountsReady -and $teaSelected)
  $script:TeaControls.ImportCodeButton.IsEnabled = [bool]($teaFree -and $teaAccountsReady -and $teaSelected -and -not [string]::IsNullOrWhiteSpace($script:TeaControls.LegacyCodeInput.Text))
  $script:TeaControls.SaveSettingsButton.IsEnabled = [bool]($teaFree -and $teaConfigured -and $script:TeaSettings -and $script:TeaSettingsDirty)
  $script:TeaControls.ReloadSettingsButton.IsEnabled = [bool]($teaFree -and $teaConfigured)
  $script:TeaControls.SaveSettingsTopButton.IsEnabled = $script:TeaControls.SaveSettingsButton.IsEnabled
  $script:TeaControls.ReloadSettingsTopButton.IsEnabled = $script:TeaControls.ReloadSettingsButton.IsEnabled
  foreach ($teaField in $script:TeaSettingsFields.Values) { $teaField.IsEnabled = -not ($script:TeaOperation -and $script:TeaOperation.Action -eq 'settings-save') }
}

function Clear-TeaInvitation {
  $script:TeaInvitation = $null
  $script:TeaControls.InvitationCode.Clear()
  $script:TeaControls.LegacyCodeInput.Clear()
  $script:TeaControls.LegacyCodePanel.Visibility = 'Collapsed'
}

function Select-TeaAccount {
  if ($script:TeaApplyingStatus) { return }
  $teaFriend = $script:TeaControls.AccountList.SelectedItem
  $teaId = if ($teaFriend) { [string]$teaFriend.id } else { $null }
  if ($teaId -ne $script:TeaSelectedAccountId) {
    Clear-TeaInvitation
    $script:TeaSelectedAccountId = $teaId
    $script:TeaPendingAccountId = $teaId
    $script:TeaControls.InvitationPanel.Visibility = if ($teaId) { 'Visible' } else { 'Collapsed' }
    if ($teaId) {
      $script:TeaControls.InvitationTitle.Text = '「' + $teaFriend.name + '」的专属邀请'
      $script:TeaControls.InvitationHint.Text = '正在从本机加密存储读取访问码…'
    }
  }
  Update-TeaButtons
}

function Set-TeaInvitation($Value) {
  $teaFriend = $script:TeaControls.AccountList.SelectedItem
  if (-not $teaFriend -or [string]$Value.user.id -ne [string]$teaFriend.id) { return }
  Clear-TeaInvitation
  $script:TeaControls.InvitationPanel.Visibility = 'Visible'
  $script:TeaControls.InvitationTitle.Text = '「' + $teaFriend.name + '」的专属邀请'
  if ($Value.code) {
    $script:TeaInvitation = @{ Name = [string]$teaFriend.name; Code = [string]$Value.code; Id = [string]$teaFriend.id }
    $script:TeaControls.InvitationCode.Text = $script:TeaInvitation.Code
    $script:TeaControls.InvitationHint.Text = '访问码已加密保存在本机；以后重新打开助手、选中这位朋友，仍可查看。'
  } else {
    $script:TeaControls.InvitationHint.Text = '这位朋友使用旧版邀请，尚未保存可查看的访问码。'
    $script:TeaControls.LegacyCodePanel.Visibility = 'Visible'
  }
  Update-TeaButtons
}

function Set-TeaSettings($Settings, $Schema, [switch]$Force) {
  if (-not $Settings -or -not $Schema) { return }
  if ($script:TeaSettingsDirty -and -not $Force) {
    if ($script:TeaSettings.version -ne $Settings.version) {
      $script:TeaControls.SettingsState.Text = '设置已在其他窗口更改。你的未保存输入已保留；请先复制需要保留的内容，再点击“放弃修改，重新读取”。'
    }
    return
  }
  if (-not $Force -and $script:TeaSettings -and $script:TeaSettings.version -eq $Settings.version -and $script:TeaSettingsFields.Count -gt 0) { return }
  $script:TeaApplyingSettings = $true
  try {
    $script:TeaSettings = $Settings
    $script:TeaSettingsFields = @{}
    $script:TeaControls.SettingsFieldsPanel.Children.Clear()
    $teaGroup = $null
    $teaGroupPanel = $null
    foreach ($teaField in $Schema) {
      if ($teaField.group -ne $teaGroup -or -not $teaGroupPanel) {
        $teaGroup = $teaField.group
        $teaCard = [Windows.Controls.Border]::new()
        $teaCard.Style = $script:TeaWindow.FindResource('Card')
        $teaCard.Margin = [Windows.Thickness]::new(0,0,0,14)
        $teaGroupPanel = [Windows.Controls.StackPanel]::new()
        $teaTitle = [Windows.Controls.TextBlock]::new()
        $teaTitle.Text = [string]$teaGroup
        $teaTitle.FontSize = 16
        $teaTitle.FontWeight = [Windows.FontWeights]::SemiBold
        $teaTitle.Margin = [Windows.Thickness]::new(0,0,0,14)
        [void]$teaGroupPanel.Children.Add($teaTitle)
        $teaCard.Child = $teaGroupPanel
        [void]$script:TeaControls.SettingsFieldsPanel.Children.Add($teaCard)
      }
      $teaRow = [Windows.Controls.Grid]::new()
      $teaRow.Margin = [Windows.Thickness]::new(0,0,0,15)
      $teaLabelCol = [Windows.Controls.ColumnDefinition]::new()
      $teaLabelCol.Width = [Windows.GridLength]::new(1, [Windows.GridUnitType]::Star)
      [void]$teaRow.ColumnDefinitions.Add($teaLabelCol)
      $teaInputCol = [Windows.Controls.ColumnDefinition]::new()
      $teaInputCol.Width = [Windows.GridLength]::new(140)
      [void]$teaRow.ColumnDefinitions.Add($teaInputCol)
      $teaLabels = [Windows.Controls.StackPanel]::new()
      $teaLabels.Margin = [Windows.Thickness]::new(0,0,20,0)
      $teaLabel = [Windows.Controls.TextBlock]::new()
      $teaLabel.Text = [string]$teaField.label
      $teaLabel.TextWrapping = 'Wrap'
      $teaLabel.FontWeight = [Windows.FontWeights]::SemiBold
      [void]$teaLabels.Children.Add($teaLabel)
      $teaHelp = [Windows.Controls.TextBlock]::new()
      $teaHelp.Text = [string]$teaField.help + '（可填 ' + $teaField.min + ' – ' + $teaField.max + '）'
      $teaHelp.Style = $script:TeaWindow.FindResource('Muted')
      $teaHelp.FontSize = 11
      $teaHelp.Margin = [Windows.Thickness]::new(0,4,0,0)
      [void]$teaLabels.Children.Add($teaHelp)
      [void]$teaRow.Children.Add($teaLabels)
      $teaInput = [Windows.Controls.TextBox]::new()
      $teaInput.Text = ([double]$Settings.values.($teaField.key)).ToString('0.################', [Globalization.CultureInfo]::InvariantCulture)
      $teaInput.VerticalAlignment = 'Top'
      $teaInput.MaxLength = 18
      $teaInput.Tag = $teaField
      [Windows.Automation.AutomationProperties]::SetName($teaInput, [string]$teaField.label)
      $teaInput.Add_TextChanged({
        if (-not $script:TeaApplyingSettings) {
          $script:TeaSettingsDirty = $true
          $script:TeaControls.SettingsState.Text = '有未保存的修改。点击下方“保存设置”后生效；自动刷新不会覆盖你的输入。'
          Update-TeaButtons
        }
      })
      [Windows.Controls.Grid]::SetColumn($teaInput, 1)
      [void]$teaRow.Children.Add($teaInput)
      [void]$teaGroupPanel.Children.Add($teaRow)
      $script:TeaSettingsFields[[string]$teaField.key] = $teaInput
    }
    $script:TeaSettingsDirty = $false
    $script:TeaControls.SettingsState.Text = '当前设置已保存，适用于所有受邀朋友。保存调整后立即生效。'
  } finally { $script:TeaApplyingSettings = $false }
  Update-TeaButtons
}

function Save-TeaSettings {
  if (-not $script:TeaSettings -or $script:TeaOperation) { return }
  $teaValues = @{}
  foreach ($teaProperty in $script:TeaSettings.values.PSObject.Properties) { $teaValues[$teaProperty.Name] = $teaProperty.Value }
  foreach ($teaEntry in $script:TeaSettingsFields.GetEnumerator()) {
    $teaField = $teaEntry.Value.Tag
    $teaNumber = 0.0
    if (-not [double]::TryParse($teaEntry.Value.Text.Trim(), [Globalization.NumberStyles]::AllowDecimalPoint, [Globalization.CultureInfo]::InvariantCulture, [ref]$teaNumber) -or
        [double]::IsNaN($teaNumber) -or [double]::IsInfinity($teaNumber) -or $teaNumber -lt [double]$teaField.min -or $teaNumber -gt [double]$teaField.max -or
        ([double]$teaField.step -eq 1 -and $teaNumber -ne [Math]::Floor($teaNumber))) {
      $script:TeaControls.SettingsState.Text = '请检查“' + $teaField.label + '”：填写 ' + $teaField.min + ' 到 ' + $teaField.max + ' 之间的' + $(if ([double]$teaField.step -eq 1) { '整数。' } else { '数字。' })
      [void]$teaEntry.Value.Focus()
      return
    }
    $teaValues[$teaEntry.Key] = $teaNumber
  }
  $script:TeaControls.SettingsState.Text = '正在保存…'
  Start-TeaOperation 'settings-save' @{ version = $script:TeaSettings.version; values = $teaValues }
}

function Set-TeaBadge([string]$Prefix, [string]$Label, [string]$Tone) {
  $script:TeaControls[$Prefix + 'State'].Text = $Label
  $script:TeaControls[$Prefix + 'Badge'].Background = switch ($Tone) { 'good' { '#E4F0E1' } 'bad' { '#FFF0E6' } default { '#EEF1EC' } }
  $script:TeaControls[$Prefix + 'State'].Foreground = switch ($Tone) { 'good' { '#36704B' } 'bad' { '#A36238' } default { '#738172' } }
}

function Set-TeaStatus($Value) {
  $script:TeaStatus = $Value
  switch ($Value.app.state) {
    'running' { Set-TeaBadge 'App' '运行中' 'good' }
    'stopped' { Set-TeaBadge 'App' '已停止' 'neutral' }
    'unconfigured' { Set-TeaBadge 'App' '未配置' 'bad' }
    default { Set-TeaBadge 'App' '需检查' 'bad' }
  }
  switch ($Value.funnel.state) {
    'enabled' { Set-TeaBadge 'Share' '已开启' 'good' }
    'disabled' { Set-TeaBadge 'Share' '已关闭' 'neutral' }
    'conflict' { Set-TeaBadge 'Share' '配置冲突' 'bad' }
    default { Set-TeaBadge 'Share' '未就绪' 'bad' }
  }
  $script:TeaControls.AppDetail.Text = [string]$Value.app.message
  $script:TeaControls.ShareDetail.Text = [string]$Value.funnel.message
  $teaUrl = Get-TeaSafeUrl $Value.publicOrigin
  $script:TeaControls.UrlText.Text = if ($teaUrl) { $teaUrl } else { '尚未配置分享网址，请先完成部署设置' }
  $teaSelected = $script:TeaControls.AccountList.SelectedValue
  if (-not $teaSelected -and $script:TeaSelectedAccountId) { $teaSelected = $script:TeaSelectedAccountId }
  $teaVisibleAccounts = @($Value.accounts | Where-Object { -not $_.revokedAt } | ForEach-Object {
    $teaDateLabel = '独立的聊天与笔记'
    try { $teaDateLabel = ([DateTimeOffset]::Parse($_.createdAt).ToLocalTime().ToString('yyyy-MM-dd')) + ' 创建' } catch {}
    if ($_.usage) {
      $teaDateLabel = '今日 ¥' + ([double]$_.usage.dailyCny).ToString('0.####', [Globalization.CultureInfo]::InvariantCulture) + ' · ' + $_.usage.dailyCalls + ' 次调用'
    }
    [pscustomobject]@{ id = $_.id; name = $_.name; dateLabel = $teaDateLabel }
  })
  $script:TeaApplyingStatus = $true
  try {
    $script:TeaControls.AccountList.ItemsSource = $teaVisibleAccounts
    if ($teaSelected) { $script:TeaControls.AccountList.SelectedValue = $teaSelected }
    if (-not $script:TeaControls.AccountList.SelectedItem -and $teaVisibleAccounts.Count -gt 0) { $script:TeaControls.AccountList.SelectedIndex = 0 }
  } finally { $script:TeaApplyingStatus = $false }
  Select-TeaAccount
  $script:TeaControls.EmptyAccounts.Visibility = if ($teaVisibleAccounts.Count -eq 0) { 'Visible' } else { 'Collapsed' }
  $script:TeaControls.AccountCount.Text = [string]$teaVisibleAccounts.Count + ' 位朋友可访问'
  $script:TeaControls.AccountsError.Text = [string]$Value.accountsError
  $script:TeaControls.AccountsError.Visibility = if ($Value.accountsError) { 'Visible' } else { 'Collapsed' }
  $script:TeaControls.EmptyAccounts.Text = if ($Value.accountsError) { '邀请列表暂不可读取' } else { '还没有邀请朋友' }
  if ($Value.accountsError) { $script:TeaControls.AccountCount.Text = '暂不可读取' }
  $script:TeaControls.RevokedCount.Text = if ($Value.accountCounts.revoked -gt 0) { '已隐藏 ' + $Value.accountCounts.revoked + ' 个已撤销账号；历史记录仍保留。' } else { '撤销访问不会删除对方的历史记录。' }
  if ($Value.limits) {
    $teaUserQuota = ([double]$Value.limits.userDailyCny).ToString('0.##', [Globalization.CultureInfo]::InvariantCulture)
    $teaDailyQuota = ([double]$Value.limits.dailyCny).ToString('0.##', [Globalization.CultureInfo]::InvariantCulture)
    $teaMonthlyQuota = ([double]$Value.limits.monthlyCny).ToString('0.##', [Globalization.CultureInfo]::InvariantCulture)
    $script:TeaControls.QuotaText.Text = '估算额度保护  ·  每人每天 ¥' + $teaUserQuota + '  /  全站每天 ¥' + $teaDailyQuota + '  /  每月 ¥' + $teaMonthlyQuota
  } else { $script:TeaControls.QuotaText.Text = '额度保护尚未配置；完成部署后会在这里显示。' }
  $script:TeaControls.UsageText.Text = if ($Value.usage) {
    '全站今日估算 ¥' + ([double]$Value.usage.dailyCny).ToString('0.####', [Globalization.CultureInfo]::InvariantCulture) + ' · ' + $Value.usage.dailyCalls + ' 次调用 · 本月估算 ¥' + ([double]$Value.usage.monthlyCny).ToString('0.####', [Globalization.CultureInfo]::InvariantCulture) + '（UTC 自然日/月）'
  } else { '' }
  Set-TeaSettings $Value.settings $Value.settingsSchema
  $script:TeaControls.UpdatedText.Text = '本机状态更新于 ' + [DateTime]::Now.ToString('HH:mm:ss') + ' · 每 20 秒自动检查'
  $script:TeaLastRefresh = [DateTime]::Now
  Update-TeaButtons
}

function Close-TeaOperation {
  if ($script:TeaOperation) {
    try { $script:TeaOperation.Process.Dispose() } catch {}
    $script:TeaOperation = $null
  }
  Update-TeaButtons
}

function Start-TeaOperation([string]$Action, [hashtable]$InputData = @{}, [switch]$Quiet) {
  if ($script:TeaOperation -or -not $script:TeaAvailable) { return }
  if ($Action -notin @('status','start','stop','share-start','share-stop','invite','revoke','account-code','account-code-import','account-code-reset','settings-save')) { throw 'Unknown sharing action.' }
  if (-not $Quiet) {
    $teaProgress = switch ($Action) {
      'status' { '正在检查网站与分享状态…' }
      'start' { '正在启动网站，通常需要几秒钟…' }
      'stop' { '正在停止网站…' }
      'share-start' { '正在开启公开分享…' }
      'share-stop' { '正在关闭公开分享…' }
      'invite' { '正在为这位朋友创建专属邀请…' }
      'revoke' { '正在撤销访问权限…' }
      'account-code' { '正在读取所选朋友的访问码…' }
      'account-code-import' { '正在验证并加密保存原访问码…' }
      'account-code-reset' { '正在重置访问码，聊天和笔记会保留…' }
      'settings-save' { '正在保存额度与使用限制…' }
    }
    Set-TeaNotice $teaProgress
  }
  $teaProcess = [Diagnostics.Process]::new()
  try {
    $teaStart = [Diagnostics.ProcessStartInfo]::new()
    $teaStart.FileName = $script:TeaNode
    # Only fixed action names are arguments. User-supplied names and IDs travel over stdin.
    $teaStart.Arguments = '--import tsx "' + $script:TeaBackend + '" ' + $Action
    $teaStart.WorkingDirectory = $script:TeaRoot
    $teaStart.UseShellExecute = $false
    $teaStart.CreateNoWindow = $true
    $teaStart.RedirectStandardOutput = $true
    $teaStart.RedirectStandardError = $true
    $teaStart.RedirectStandardInput = $true
    $teaStart.StandardOutputEncoding = [Text.UTF8Encoding]::new($false)
    $teaStart.StandardErrorEncoding = [Text.UTF8Encoding]::new($false)
    $teaProcess.StartInfo = $teaStart
    if (-not $teaProcess.Start()) { throw 'Unable to start sharing helper.' }
    $teaOut = $teaProcess.StandardOutput.ReadToEndAsync()
    $teaErr = $teaProcess.StandardError.ReadToEndAsync()
    # .NET Framework (Windows PowerShell 5.1) has no StandardInputEncoding property.
    # Write the UTF-8 JSON bytes directly so Chinese names do not depend on the console code page.
    $teaInputBytes = [Text.UTF8Encoding]::new($false).GetBytes(($InputData | ConvertTo-Json -Depth 10 -Compress))
    $teaProcess.StandardInput.BaseStream.Write($teaInputBytes, 0, $teaInputBytes.Length)
    $teaProcess.StandardInput.BaseStream.Flush()
    $teaProcess.StandardInput.Close()
    $script:TeaOperation = @{ Process = $teaProcess; Out = $teaOut; Err = $teaErr; Action = $Action; Began = [DateTime]::Now; Quiet = [bool]$Quiet }
  } catch {
    try { if (-not $teaProcess.HasExited) { $teaProcess.Kill() } } catch {}
    $teaProcess.Dispose()
    $script:TeaLastRefresh = [DateTime]::Now
    Set-TeaNotice '无法启动分享助手的本地组件。请确认 Node.js 已安装、项目依赖完整，然后重新打开助手。' -Problem
  }
  Update-TeaButtons
}

function Complete-TeaOperation {
  if (-not $script:TeaOperation) { return }
  $teaPending = $script:TeaOperation
  $teaLimit = if ($teaPending.Action -eq 'status') { 40 } else { 180 }
  if (-not $teaPending.Process.HasExited) {
    if (([DateTime]::Now - $teaPending.Began).TotalSeconds -gt $teaLimit) {
      try { $teaPending.Process.Kill() } catch {}
      Close-TeaOperation
      $script:TeaLastRefresh = [DateTime]::Now
      $script:TeaNoticeAfterRefresh = $null
      Set-TeaNotice '这次操作等待时间较长，助手已停止等待。网站状态可能已改变，请点击“刷新状态”确认后再操作。' -Problem
    }
    return
  }
  if (-not $teaPending.Out.IsCompleted -or -not $teaPending.Err.IsCompleted) { return }
  $teaAction = $teaPending.Action
  try {
    $teaResponse = $teaPending.Out.GetAwaiter().GetResult() | ConvertFrom-Json -ErrorAction Stop
    if ($null -eq $teaResponse.ok -or $teaResponse.action -ne $teaAction) { throw 'Invalid response.' }
  } catch {
    Close-TeaOperation
    $script:TeaLastRefresh = [DateTime]::Now
    Set-TeaNotice '未能读取本地组件的结果。请刷新状态后重试；如果持续出现，请检查项目依赖或联系维护者。' -Problem
    return
  }
  Close-TeaOperation
  if (-not $teaResponse.ok) {
    Set-TeaNotice ([string]$teaResponse.message) -Problem
    if ($teaAction -eq 'settings-save') { $script:TeaControls.SettingsState.Text = [string]$teaResponse.message + ' 你的输入已保留。' }
    if ($teaAction -like 'account-code*') { $script:TeaControls.InvitationHint.Text = [string]$teaResponse.message }
    $script:TeaNoticeAfterRefresh = $null
    $script:TeaLastRefresh = [DateTime]::Now
    return
  }
  if ($teaAction -eq 'status') {
    Set-TeaStatus $teaResponse
    if ($teaResponse.accountsError) {
      Set-TeaNotice ([string]$teaResponse.accountsError) -Problem
      $script:TeaNoticeAfterRefresh = $null
    } elseif ($script:TeaNoticeAfterRefresh) {
      Set-TeaNotice $script:TeaNoticeAfterRefresh
      $script:TeaNoticeAfterRefresh = $null
    } elseif (-not $teaPending.Quiet) {
      if (-not $teaResponse.configured) { Set-TeaNotice '还没有完成首次部署。请先按照 docs/HOSTING.md 配置 Tailscale 和邀请制网站，再来这里管理。' -Problem }
      elseif ($teaResponse.app.state -eq 'running' -and $teaResponse.funnel.state -eq 'enabled') { Set-TeaNotice '网站和公开分享已开启。复制邀请给朋友后，对方即可使用专属访问码登录。' }
      elseif ($teaResponse.app.state -eq 'stopped') { Set-TeaNotice '网站目前已停止。先点击“启动网站”，再开启分享和邀请朋友。' }
      else { Set-TeaNotice '状态已更新。请查看上方提示，按顺序完成启动和分享。' }
    }
    return
  }
  if ($teaAction -eq 'invite') {
    Clear-TeaInvitation
    $script:TeaApplyingStatus = $true
    try { $script:TeaControls.AccountList.SelectedIndex = -1 } finally { $script:TeaApplyingStatus = $false }
    # Select this new account when the fresh list arrives, then read its saved code.
    $script:TeaSelectedAccountId = [string]$teaResponse.user.id
    $script:TeaPendingAccountId = [string]$teaResponse.user.id
    $script:TeaControls.FriendName.Clear()
  } elseif ($teaAction -eq 'revoke') {
    Clear-TeaInvitation
    $script:TeaSelectedAccountId = $null
    $script:TeaPendingAccountId = $null
    $script:TeaControls.InvitationPanel.Visibility = 'Collapsed'
  } elseif ($teaAction -like 'account-code*') {
    Set-TeaInvitation $teaResponse
    if ($teaAction -ne 'account-code') { Set-TeaNotice ([string]$teaResponse.message) }
    return
  } elseif ($teaAction -eq 'settings-save') {
    $script:TeaSettingsDirty = $false
    if ($teaResponse.settings) { $script:TeaSettings = $teaResponse.settings }
    $script:TeaControls.SettingsState.Text = [string]$teaResponse.message
  }
  $script:TeaNoticeAfterRefresh = [string]$teaResponse.message
  Start-TeaOperation 'status' -Quiet
}

function Copy-TeaText([string]$Text, [string]$Success) {
  try { [Windows.Clipboard]::SetText($Text); Set-TeaNotice $Success }
  catch { Set-TeaNotice '暂时无法写入剪贴板。可以选中上方文字手动复制，或稍后再试。' -Problem }
}

function Open-TeaUrl([string]$Value, [switch]$Admin) {
  $teaSafe = Get-TeaSafeUrl $Value -Admin:$Admin
  if (-not $teaSafe) { Set-TeaNotice '网站地址无效。请刷新状态并检查部署设置。' -Problem; return }
  try {
    $teaBrowserStart = [Diagnostics.ProcessStartInfo]::new($teaSafe)
    $teaBrowserStart.UseShellExecute = $true
    [Diagnostics.Process]::Start($teaBrowserStart) | Out-Null
  } catch { Set-TeaNotice '无法打开默认浏览器。请复制网址后在浏览器中打开。' -Problem }
}

function Confirm-Tea([string]$Message, [string]$Title) {
  return [Windows.MessageBox]::Show($script:TeaWindow, $Message, $Title, [Windows.MessageBoxButton]::YesNo, [Windows.MessageBoxImage]::Question, [Windows.MessageBoxResult]::No) -eq [Windows.MessageBoxResult]::Yes
}

$script:TeaControls.RefreshButton.Add_Click({ Start-TeaOperation 'status' })
$script:TeaControls.SiteNavButton.Add_Click({ $script:TeaControls.SitePage.Visibility = 'Visible'; $script:TeaControls.SettingsPage.Visibility = 'Collapsed' })
$script:TeaControls.SettingsNavButton.Add_Click({ $script:TeaControls.SitePage.Visibility = 'Collapsed'; $script:TeaControls.SettingsPage.Visibility = 'Visible' })
$script:TeaControls.SaveSettingsButton.Add_Click({ Save-TeaSettings })
$script:TeaControls.SaveSettingsTopButton.Add_Click({ Save-TeaSettings })
$script:TeaControls.ReloadSettingsButton.Add_Click({
  if ($script:TeaSettingsDirty -and -not (Confirm-Tea '放弃尚未保存的修改，并重新读取最新设置吗？' '重新读取设置')) { return }
  $script:TeaSettingsDirty = $false
  Start-TeaOperation 'status'
})
$script:TeaControls.ReloadSettingsTopButton.Add_Click({ $script:TeaControls.ReloadSettingsButton.RaiseEvent([Windows.RoutedEventArgs]::new([Windows.Controls.Button]::ClickEvent)) })
$script:TeaControls.StartButton.Add_Click({ Start-TeaOperation 'start' })
$script:TeaControls.StopButton.Add_Click({
  if (Confirm-Tea "停止后，朋友暂时无法使用网站，正在生成的回复会被中断。`n`n聊天记录和账号会保留，之后可随时重新启动。`n`n确定停止网站吗？" '停止网站') { Start-TeaOperation 'stop' }
})
$script:TeaControls.ShareStartButton.Add_Click({ Start-TeaOperation 'share-start' })
$script:TeaControls.ShareStopButton.Add_Click({
  if (Confirm-Tea "关闭后，朋友将无法通过分享网址访问。`n`n本机网站继续运行，账号和聊天记录不会删除。`n`n确定关闭公开分享吗？" '关闭公开分享') { Start-TeaOperation 'share-stop' }
})
$script:TeaControls.CopyUrlButton.Add_Click({
  $teaPublicUrl = Get-TeaSafeUrl $script:TeaStatus.publicOrigin
  if ($teaPublicUrl) { Copy-TeaText $teaPublicUrl '网址已复制。朋友还需要自己的专属访问码，才能登录网站。' }
})
$script:TeaControls.OpenButton.Add_Click({ Open-TeaUrl $script:TeaStatus.publicOrigin })
$script:TeaControls.AdminButton.Add_Click({ Open-TeaUrl $script:TeaStatus.adminUrl -Admin })
$script:TeaControls.FriendName.Add_TextChanged({ Update-TeaButtons })
$script:TeaControls.AccountList.Add_SelectionChanged({ Select-TeaAccount })
$script:TeaControls.LegacyCodeInput.Add_TextChanged({ Update-TeaButtons })
$script:TeaControls.InviteButton.Add_Click({
  $teaName = $script:TeaControls.FriendName.Text.Trim()
  if (-not $teaName) { return }
  Start-TeaOperation 'invite' @{ name = $teaName }
})
$script:TeaControls.RevokeButton.Add_Click({
  $teaSelectedFriend = $script:TeaControls.AccountList.SelectedItem
  if ($teaSelectedFriend -and (Confirm-Tea ("撤销后，「" + $teaSelectedFriend.name + "」的访问码和已登录会话将失效。`n`n这不会删除对方的聊天和笔记。需要重新邀请时，会创建新的独立账号。`n`n确定撤销访问吗？") '撤销朋友的访问')) {
    Start-TeaOperation 'revoke' @{ id = [string]$teaSelectedFriend.id }
  }
})
$script:TeaControls.CopyInviteButton.Add_Click({
  if ($script:TeaInvitation) {
    $teaInvitationUrl = Get-TeaSafeUrl $script:TeaStatus.publicOrigin
    if ($teaInvitationUrl) {
      $teaInviteText = "邀请你来茶馆一起聊聊。`r`n网址：" + $teaInvitationUrl + "`r`n你的专属访问码：" + $script:TeaInvitation.Code + "`r`n请勿转发访问码；此账号的聊天和笔记属于你。"
      Copy-TeaText $teaInviteText ('给「' + $script:TeaInvitation.Name + '」的完整邀请已复制。请私下发送给这位朋友。')
    }
  }
})
$script:TeaControls.CopyCodeButton.Add_Click({
  if ($script:TeaInvitation) { Copy-TeaText $script:TeaInvitation.Code '访问码已复制，请私下发给对应的朋友。' }
})
$script:TeaControls.ImportCodeButton.Add_Click({
  $teaFriend = $script:TeaControls.AccountList.SelectedItem
  if ($teaFriend) { Start-TeaOperation 'account-code-import' @{ id = [string]$teaFriend.id; code = $script:TeaControls.LegacyCodeInput.Text.Trim() } }
})
$script:TeaControls.ResetCodeButton.Add_Click({
  $teaFriend = $script:TeaControls.AccountList.SelectedItem
  if ($teaFriend -and (Confirm-Tea ('重置「' + $teaFriend.name + '」的访问码后，旧码和已登录会话会立即失效。聊天、笔记和账号都保留。' + "`n`n请将新访问码重新发给对方。确定重置吗？") '重置访问码')) {
    Start-TeaOperation 'account-code-reset' @{ id = [string]$teaFriend.id }
  }
})

if ($PreviewPath) {
  # Render a deterministic mock; this path never starts Node, reads hosted data, or changes services.
  $script:TeaAvailable = $true
  $teaPreview = [pscustomobject]@{
    configured = $true
    app = @{ state = 'running'; message = '网站正在后台运行，可以接待朋友。' }
    funnel = @{ state = 'enabled'; message = 'HTTPS 分享已开启，访问仍需要专属访问码。' }
    publicOrigin = 'https://my-teahouse.example.ts.net/'
    adminUrl = 'http://127.0.0.1:4318/'
    accounts = @(@{ id = 'preview-1'; name = '小林'; createdAt = '2026-10-23T08:00:00Z' }, @{ id = 'preview-2'; name = '阿远'; createdAt = '2026-10-22T08:00:00Z' })
    accountCounts = @{ active = 2; revoked = 0 }
    limits = @{ userDailyCny = 5; dailyCny = 20; monthlyCny = 300 }
  }
  Set-TeaStatus $teaPreview
  Set-TeaInvitation ([pscustomobject]@{user = @{id = 'preview-1'}; code = 'preview-only-not-a-real-access-code'})
  Set-TeaNotice '网站和公开分享已开启。复制邀请给朋友后，对方即可使用专属访问码登录。'
  $teaImagePath = [IO.Path]::GetFullPath($PreviewPath)
  if (-not (Test-Path -LiteralPath (Split-Path -Parent $teaImagePath) -PathType Container)) { throw 'Preview output directory must already exist.' }
  $script:TeaWindow.Show()
  $script:TeaWindow.UpdateLayout()
  $script:TeaWindow.Dispatcher.Invoke([Action]{}, [Windows.Threading.DispatcherPriority]::Render)
  $teaVisual = $script:TeaControls.RootView
  $teaBitmap = [Windows.Media.Imaging.RenderTargetBitmap]::new([int]$teaVisual.ActualWidth, [int]$teaVisual.ActualHeight, 96, 96, [Windows.Media.PixelFormats]::Pbgra32)
  $teaBitmap.Render($teaVisual)
  $teaEncoder = [Windows.Media.Imaging.PngBitmapEncoder]::new()
  $teaEncoder.Frames.Add([Windows.Media.Imaging.BitmapFrame]::Create($teaBitmap))
  $teaStream = [IO.File]::Open($teaImagePath, [IO.FileMode]::Create, [IO.FileAccess]::Write)
  try { $teaEncoder.Save($teaStream) } finally { $teaStream.Dispose(); $script:TeaWindow.Close() }
  exit 0
}

try {
  $teaNodeCommand = Get-Command node.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1
  $script:TeaNode = [IO.Path]::GetFullPath($teaNodeCommand.Source)
  if (-not (Test-Path -LiteralPath $script:TeaBackend -PathType Leaf) -or -not (Test-Path -LiteralPath (Join-Path $script:TeaRoot 'node_modules/tsx/package.json') -PathType Leaf)) { throw 'Missing sharing helper or project dependencies.' }
  $script:TeaAvailable = $true
} catch {
  Set-TeaNotice '缺少 Node.js 或项目依赖。请先安装 Node.js 24 或更高版本，并完成项目首次安装，再重新打开分享助手。' -Problem
  Set-TeaBadge 'App' '未就绪' 'bad'
  Set-TeaBadge 'Share' '未检查' 'neutral'
  $script:TeaControls.AppDetail.Text = '本地启动环境尚未准备好。'
  $script:TeaControls.ShareDetail.Text = '补齐运行环境后，助手将重新检查。'
  $script:TeaControls.UrlText.Text = '完成首次安装后显示分享网址'
  $script:TeaControls.QuotaText.Text = '完成首次安装后显示额度保护设置。'
}

$script:TeaTimer = [Windows.Threading.DispatcherTimer]::new()
$script:TeaTimer.Interval = [TimeSpan]::FromMilliseconds(250)
$script:TeaTimer.Add_Tick({
  if ($script:TeaClosing) { return }
  try {
    Complete-TeaOperation
    if ($script:TeaAvailable -and -not $script:TeaOperation -and $script:TeaPendingAccountId) {
      $teaPendingId = $script:TeaPendingAccountId
      $script:TeaPendingAccountId = $null
      Start-TeaOperation 'account-code' @{ id = $teaPendingId } -Quiet
    }
    if ($script:TeaAvailable -and -not $script:TeaOperation -and ([DateTime]::Now - $script:TeaLastRefresh).TotalSeconds -ge 20) { Start-TeaOperation 'status' -Quiet }
  } catch {
    Close-TeaOperation
    $script:TeaLastRefresh = [DateTime]::Now
    Set-TeaNotice '助手暂时无法更新状态。网站不会因此停止；请点击“刷新状态”再试。' -Problem
  }
})
$script:TeaWindow.Add_ContentRendered({
  if ($script:TeaAvailable) { Start-TeaOperation 'status' }
  $script:TeaTimer.Start()
})
$script:TeaWindow.Add_Closing({
  param($Sender, $EventArgs)
  if ($script:TeaOperation -and $script:TeaOperation.Action -notin @('status','account-code')) {
    $EventArgs.Cancel = $true
    [Windows.MessageBox]::Show($script:TeaWindow, '正在完成当前操作，请稍等片刻。完成后可关闭窗口，网站会继续运行。', '操作进行中', [Windows.MessageBoxButton]::OK, [Windows.MessageBoxImage]::Information) | Out-Null
    return
  }
  if ($script:TeaSettingsDirty -and -not (Confirm-Tea '额度与限制还有未保存的修改，确定放弃修改并关闭吗？网站会继续运行，访问码下次仍可查看。' '关闭分享助手')) { $EventArgs.Cancel = $true; return }
  $script:TeaClosing = $true
  $script:TeaTimer.Stop()
  if ($script:TeaOperation) {
    try { if (-not $script:TeaOperation.Process.HasExited) { $script:TeaOperation.Process.Kill() } } catch {}
    Close-TeaOperation
  }
  Clear-TeaInvitation
})
Update-TeaButtons
[void]$script:TeaWindow.ShowDialog()
