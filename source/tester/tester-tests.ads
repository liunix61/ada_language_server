------------------------------------------------------------------------------
--                         Language Server Protocol                         --
--                                                                          --
--                     Copyright (C) 2018-2023, AdaCore                     --
--                                                                          --
-- This is free software;  you can redistribute it  and/or modify it  under --
-- terms of the  GNU General Public License as published  by the Free Soft- --
-- ware  Foundation;  either version 3,  or (at your option) any later ver- --
-- sion.  This software is distributed in the hope  that it will be useful, --
-- but WITHOUT ANY WARRANTY;  without even the implied warranty of MERCHAN- --
-- TABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU General Public --
-- License for  more details.  You should have  received  a copy of the GNU --
-- General  Public  License  distributed  with  this  software;   see  file --
-- COPYING3.  If not, go to http://www.gnu.org/licenses for a complete copy --
-- of the license.                                                          --
------------------------------------------------------------------------------

with Ada.Calendar;
with Ada.Containers.Hashed_Sets;
with Ada.Strings.Unbounded;

with VSS.Strings;
private with VSS.Strings.Hash;

with GNATCOLL.JSON;

with LSP.Raw_Clients;

with Spawn.String_Vectors;
with Spawn.Environments;

package Tester.Tests is

   type Test is tagged limited private;

   procedure Run
     (Self          : in out Test;
      File          : VSS.Strings.Virtual_String;
      Commands      : GNATCOLL.JSON.JSON_Array;
      On_Hang       : VSS.Strings.Virtual_String;
      Debug         : Boolean;
      Output_Format : VSS.Strings.Virtual_String);
   --  Execute the test (provided as JSON array). If the test hangs then
   --  spawn On_Hang command. If Debug=True then execute the test in a debug
   --  mode: suppress timeouts and pause test execution after the server
   --  starting.

private

   task type Watch_Dog_Task is
      entry Start
        (Timeout : Duration;
         Command : Ada.Strings.Unbounded.Unbounded_String);

      entry Restart;

      entry Cancel;
   end Watch_Dog_Task;

   package String_Sets is new Ada.Containers.Hashed_Sets
     (VSS.Strings.Virtual_String,
      VSS.Strings.Hash,
      VSS.Strings."=",
      VSS.Strings."=");

   type Test is new LSP.Raw_Clients.Raw_Client with record
      File         : VSS.Strings.Virtual_String;
      Index        : Positive := 1;
      Sort_Reply   : GNATCOLL.JSON.JSON_Value;
      Waits        : GNATCOLL.JSON.JSON_Array;
      --  Array of JSON object to wait
      In_Debug     : Boolean;
      --  In debug mode (disable timeout, pause after start)
      On_Hang     : VSS.Strings.Virtual_String;
      --  A command to execute if the test hangs
      Output_Format : VSS.Strings.Virtual_String;
      --  A string in the list ["verbose", "recent", "diff", "min_diff"]
      Watch_Dog    : Watch_Dog_Task;
      --  Task to restrict a command execution time
      Started      : Ada.Calendar.Time;
      --  Command execution start/reset time
      Known_Ids    : String_Sets.Set;
      --  Set of processed request ids

      Full_Server_Output : GNATCOLL.JSON.JSON_Array;
      --  Complete output received from the server

      Recent_Server_Output : GNATCOLL.JSON.JSON_Array;

      Environment  : Spawn.Environments.Process_Environment :=
        Spawn.Environments.System_Environment;
      --  Environment to launch child process (ALS, Shell);

   end record;

   overriding procedure On_Error
     (Self  : in out Test;
      Error : String);

   overriding procedure On_Raw_Message
     (Self    : in out Test;
      Data    : Ada.Strings.Unbounded.Unbounded_String;
      Success : in out Boolean);

   overriding function Error_Message
     (Self : Test) return VSS.Strings.Virtual_String
        is (VSS.Strings.Empty_Virtual_String);

   procedure Execute_Command
     (Self    : in out Test;
      Command : GNATCOLL.JSON.JSON_Value);

   procedure Do_Abort (Self : Test);

   procedure Do_Fail
     (Self : in out Test;
      Text : Spawn.String_Vectors.UTF_8_String_Vector);
   --  Mark test as failed with given Text

end Tester.Tests;
