using System.Text.Json;
using Microsoft.Extensions.DependencyInjection;

namespace ConflictDemo;

public class App
{
    // This code compiles fine, but NuGet reports NU1605 because
    // DI 9.0.0 needs System.Text.Json >= 9.0.0 but we pin 8.0.0
    public string Run()
    {
        var services = new ServiceCollection();
        return JsonSerializer.Serialize(services);
    }
}
