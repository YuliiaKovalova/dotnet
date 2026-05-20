using System;

// Deliberate errors to simulate a real insertion failure
namespace BrokenProject
{
    public class Service
    {
        // CS0246: type not found (simulates API break from upstream)
        private readonly INewApiThatDoesNotExist _api;

        // CS0117: missing member (simulates removed API)
        public void Run() => Console.WriteLineButBroken("hello");

        // CS1061: missing member on type
        public void Configure(string logger) => logger.LogCriticalButRemoved("fail");
    }
}
